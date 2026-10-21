import express from "express";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Zalo, ThreadType } from "zca-js";

const PORT = 3000;
const MEDIA_GROUP_WAIT = 2000; // gom ảnh/video của CÙNG 1 người gửi liên tiếp thành 1 cụm (ms)
const TEXT_DUP_WINDOW = 10 * 60 * 1000; // không gửi lại cùng 1 nội dung chữ tới cùng 1 nhóm phụ trong 10 phút
const MAX_DOWNLOADS = 5; // số file tải cùng lúc
const MAX_SENDS = 4; // số lệnh gửi gọi Zalo cùng lúc (tránh bị Zalo giới hạn tốc độ)
const SEND_GAP = 120; // nghỉ giữa 2 lần gửi liên tiếp tới cùng 1 nhóm (ms)
const DOWNLOAD_TIMEOUT = 25000; // mỗi lần tải tối đa (ms)
const SEND_RETRIES = 3; // thử lại khi mạng lỗi (chỉ lỗi chắc chắn chưa gửi được)
const ALBUM_MAX = 10; // tối đa số ảnh / 1 lần gửi
const SOLD_OUT_MAX_LEN = 300; // chỉ xét tin báo hết phòng với tin ngắn (bài đăng phòng thường dài hơn nhiều)
const MANY_CODES_MIN = 5;
// Chỉ chuyển tiếp tin chữ thuộc các loại này; sticker, thoại, danh thiếp, bình chọn... bị bỏ qua (hiện rõ trong bảng)
const TEXT_TYPES = new Set(["webchat", "chat.recommended"]); // tin có từ ngần này mã tòa (MTxxx) trở lên coi là tin tổng hợp

const CONFIG_FILE = path.join(process.cwd(), "config.json");
const SESSION_FILE = path.join(process.cwd(), "session.json");
const TEMP_DIR = path.join(process.cwd(), "temp_media");

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(TEMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ==================================================
// ĐĂNG NHẬP ZALO (lưu phiên để lần sau không quét QR)
// ==================================================

async function imageMetadataGetter(filePath) {
    try {
        const data = await fs.promises.readFile(filePath);
        const { width, height } = await sharp(data).metadata();
        return { width: width || 720, height: height || 720, size: data.length };
    } catch {
        return { width: 720, height: 720, size: 10000 };
    }
}

function saveSession(api) {
    try {
        const ctx = api.getContext();
        const cookie = api.getCookie().toJSON().cookies;
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookie, imei: ctx.imei, userAgent: ctx.userAgent }, null, 2));
        log("💾 Đã lưu phiên đăng nhập");
    } catch (err) {
        console.warn("⚠️ Không lưu được phiên đăng nhập:", err.message);
    }
}

async function loginZalo() {
    const zalo = new Zalo({ imageMetadataGetter, selfListen: true });

    if (fs.existsSync(SESSION_FILE)) {
        try {
            const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("quá thời gian chờ")), 30000));
            const api = await Promise.race([zalo.login(session), timeout]);
            log("✅ Đăng nhập bằng phiên đã lưu, không cần quét QR\n");
            saveSession(api);
            return api;
        } catch (err) {
            console.warn("⚠️ Phiên cũ không dùng được (" + err.message + ") → quét QR lại");
            fs.rmSync(SESSION_FILE, { force: true });
        }
    }

    const api = await zalo.loginQR();
    log("✅ Đăng nhập Zalo thành công!\n");
    saveSession(api);
    return api;
}

try {
    const v = JSON.parse(fs.readFileSync(path.join(process.cwd(), "node_modules/zca-js/package.json"), "utf8")).version;
    log("📦 zca-js phiên bản", v);
} catch {}

log("\n⏳ ĐANG ĐĂNG NHẬP ZALO...");
const api = await loginZalo();

// ==================================================
// DANH SÁCH NHÓM (kèm ảnh đại diện)
// ==================================================

async function loadGroups() {
    const list = [];
    try {
        const all = await api.getAllGroups();
        const ids = Object.keys(all.gridVerMap || {});
        log("⏳ Đang lấy thông tin", ids.length, "nhóm...");

        const chunks = [];
        for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

        const results = await Promise.allSettled(chunks.map((c) => api.getGroupInfo(c)));
        for (const r of results) {
            if (r.status !== "fulfilled") continue;
            for (const [id, g] of Object.entries(r.value.gridInfoMap || {})) {
                list.push({ id, name: g.name || "Không có tên", avt: g.avt || g.fullAvt || "" });
            }
        }
        list.sort((a, b) => a.name.localeCompare(b.name, "vi"));
        log("✅ Đã lấy", list.length, "nhóm");
    } catch (err) {
        console.error("❌ Lỗi lấy danh sách nhóm:", err.message);
    }
    return list;
}

const groupsList = await loadGroups();

// ==================================================
// CẤU HÌNH (config.json)
// ==================================================

let rules = [];
let ruleMap = new Map(); // mainGroupId -> subGroupIds[]

// Dòng chứa từ khóa này sẽ bị xóa khỏi tin (phần còn lại vẫn gửi)
let removeKeywords = ["🌹", "🚩", "90land.vn"];
// Tin chứa từ khóa này sẽ KHÔNG được chuyển tiếp (bỏ cả tin), không phân biệt hoa/thường/dấu
let blockKeywords = ["NGUỒN CHỐT NHANH", "TOP NGUỒN NHÀ MỚI", "NGUỒN NHÀ ƯU TIÊN"];
// Chặn tin tổng hợp liệt kê nhiều mã tòa (từ MANY_CODES_MIN mã trở lên)
let blockManyCodes = true;
// Chặn tin báo hết phòng kiểu "@All hết MT534, MT618"
let blockSoldOut = true;
let rev = 0; // tăng mỗi lần lưu; trang web cũ (tab/thiết bị khác) lưu đè sẽ bị từ chối

const cleanList = (v) => (Array.isArray(v) ? v.map((k) => String(k).trim()).filter(Boolean) : null);

function applyConfig(cfg) {
    const c = Array.isArray(cfg) ? { rules: cfg } : cfg || {};

    rules = (Array.isArray(c.rules) ? c.rules : [])
        .filter((r) => r && typeof r.mainGroupId === "string")
        .map((r) => ({
            mainGroupId: r.mainGroupId,
            subGroupIds: [...new Set(r.subGroupIds || [])].filter((id) => id && id !== r.mainGroupId)
        }));
    ruleMap = new Map(rules.filter((r) => r.mainGroupId && r.subGroupIds.length).map((r) => [r.mainGroupId, r.subGroupIds]));

    for (const [main, subs] of ruleMap) {
        const chained = [...ruleMap].filter(([m, s]) => m !== main && s.includes(main)).length;
        if (chained) console.warn(`⚠️ Nhóm ${main} vừa là nhóm chính vừa là nhóm phụ của cấu hình khác: tin người khác nhắn trong đó sẽ bị chuyển tiếp tiếp`);
    }

    removeKeywords = cleanList(c.removeKeywords) ?? removeKeywords;
    blockKeywords = cleanList(c.blockKeywords) ?? blockKeywords;
    if (typeof c.blockManyCodes === "boolean") blockManyCodes = c.blockManyCodes;
    if (typeof c.blockSoldOut === "boolean") blockSoldOut = c.blockSoldOut;
}

const currentConfig = () => ({ rules, removeKeywords, blockKeywords, blockManyCodes, blockSoldOut, rev });

try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    applyConfig(saved);
    rev = Number(saved.rev) || 0;
    log("✅ Đã nạp cấu hình:", ruleMap.size, "nhóm chính");
} catch {}

// ==================================================
// THEO DÕI HOẠT ĐỘNG (hiện trên giao diện)
// ==================================================

const stats = { received: 0, forwarded: 0, failed: 0, skipped: 0 };
const feed = []; // mới nhất ở đầu
let feedSeq = 0;
let connection = "connecting"; // connecting | connected | disconnected

const groupName = new Map(groupsList.map((g) => [g.id, g.name]));

function track(mainId, kind, preview, subIds = []) {
    const to = subIds.map((id) => groupName.get(id) || id);
    const it = { id: ++feedSeq, t: Date.now(), mainId, kind, preview, to, state: "queued", done: 0, total: 0, note: "" };
    feed.unshift(it);
    if (feed.length > 80) feed.length = 80;
    stats.received++;
    return it;
}

// state: done | failed | skipped
function finish(it, state, note = "") {
    if (it.final) return;
    it.final = true;
    it.state = state;
    it.note = note;
    if (state === "done") stats.forwarded++;
    else if (state === "failed") stats.failed++;
    else stats.skipped++;
}

// ==================================================
// WEB + API
// ==================================================

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/api/groups", (_req, res) => res.json(groupsList));
app.get("/api/config", (_req, res) => res.json(currentConfig()));
app.post("/api/config", async (req, res) => {
    if (typeof req.body?.rev === "number" && req.body.rev !== rev) return res.status(409).json({ error: "stale", rev });
    applyConfig(req.body);
    rev++;
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(currentConfig(), null, 2));
    res.json({ success: true, rev });
});
app.get("/api/status", (_req, res) => {
    const pending = stats.received - stats.forwarded - stats.failed - stats.skipped;
    res.json({ connection, stats: { ...stats, pending }, feed });
});

app.listen(PORT, () => log(`🚀 WEB ĐANG CHẠY 👉 http://localhost:${PORT}`));

// ==================================================
// TIỆN ÍCH
// ==================================================

const parseJSON = (v) => {
    if (v && typeof v === "object") return v;
    try {
        return JSON.parse(v);
    } catch {
        return {};
    }
};

const oneLine = (s, n = 70) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

const KNOWN_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);

function extFromUrl(url, fallback) {
    try {
        const ext = path.extname(new URL(url).pathname).toLowerCase();
        if (KNOWN_EXT.has(ext)) return ext;
    } catch {}
    return fallback;
}

// Bộ giới hạn số việc chạy cùng lúc (slot được chuyển thẳng cho người đợi kế tiếp)
function limiter(max) {
    let active = 0;
    const waiters = [];
    return async (fn) => {
        if (active >= max) await new Promise((r) => waiters.push(r));
        else active++;
        try {
            return await fn();
        } finally {
            const next = waiters.shift();
            if (next) next();
            else active--;
        }
    };
}
const withDownloadSlot = limiter(MAX_DOWNLOADS);
const withSendSlot = limiter(MAX_SENDS);

// Tải 1 file: thử lần lượt các link (ảnh nét -> ảnh thường -> ảnh nhỏ), tối đa 3 vòng
function downloadMedia(urls, fallbackExt = ".jpg", forceExt = null) {
    const list = [...new Set([].concat(urls).filter(Boolean))];
    return withDownloadSlot(async () => {
        let lastErr = new Error("không có đường dẫn");
        for (let round = 1; round <= 3; round++) {
            for (const url of list) {
                try {
                    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);

                    const buf = Buffer.from(await res.arrayBuffer());
                    if (!buf.length) throw new Error("file rỗng");

                    const ext = forceExt || extFromUrl(list[0], fallbackExt);
                    const filePath = path.join(TEMP_DIR, `media_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
                    await fs.promises.writeFile(filePath, buf);
                    return filePath;
                } catch (err) {
                    lastErr = err;
                }
            }
            if (round < 3) await sleep(round * 1500);
        }
        throw lastErr;
    });
}

// Chỉ thử lại khi chắc chắn tin CHƯA tới Zalo (mất mạng/DNS), tránh gửi trùng
const SAFE_RETRY_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);
const isSafeToRetry = (err) => SAFE_RETRY_CODES.has(err?.code) || SAFE_RETRY_CODES.has(err?.cause?.code);

async function withRetry(fn) {
    for (let i = 0; ; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i >= SEND_RETRIES || !isSafeToRetry(err)) throw err;
            log(`⚠️ Mạng lỗi, thử lại lần ${i + 1}...`);
            await sleep((i + 1) * 3000);
        }
    }
}

// ---------- Xử lý nội dung chữ ----------

// Chuẩn hóa: chữ in đậm kiểu 𝐌𝐀̃ -> chữ thường, hạ chữ hoa
const fold = (s) => s.normalize("NFKC").toLowerCase();
// Thêm bỏ dấu tiếng Việt (để "nguon chot nhanh" cũng khớp "NGUỒN CHỐT NHANH")
const plain = (s) => fold(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");

// Xóa dòng chứa từ khóa, gộp dòng trống liên tiếp
function cleanText(text) {
    const keys = removeKeywords.map(fold).filter(Boolean);
    return text
        .split("\n")
        .filter((line) => !keys.some((k) => fold(line).includes(k)))
        .join("\n")
        .replace(/\n[ \t]*(\n[ \t]*)+/g, "\n\n")
        .trim();
}

// Trả về lý do nếu tin bị chặn (không chuyển tiếp), rỗng nếu được phép
function blockedReason(text) {
    const p = plain(text);
    for (const k of blockKeywords) {
        const key = plain(k);
        if (key && p.includes(key)) return `chứa "${k}"`;
    }
    if (blockManyCodes) {
        const codes = new Set(text.toUpperCase().match(/\bMT\d{2,5}\b/g) || []);
        if (codes.size >= MANY_CODES_MIN) return `tin tổng hợp ${codes.size} mã tòa`;
    }
    // Tin ngắn có "hết" đi liền với mã tòa: "@All hết MT534", "MT534 hết phòng"...
    if (blockSoldOut && text.length <= SOLD_OUT_MAX_LEN && (/\bhet\b[^\n]{0,40}\bmt\d{2,5}\b/.test(p) || /\bmt\d{2,5}\b[^\n]{0,40}\bhet\b/.test(p))) {
        return "tin báo hết phòng";
    }
    return "";
}

// ---------- Nhận diện tin ----------

function messageKey(data) {
    const id = data.msgId || data.cliMsgId;
    if (!id) return null;
    const c = data.content;
    const fp = typeof c === "string" ? c : c?.href || c?.thumb || c?.title || "";
    return createHash("md5").update(`${id}|${fp}`).digest("hex");
}

// Zalo đôi khi báo cùng 1 tin 2 lần => bỏ qua tin đã xử lý (10 phút)
const seen = new Map();
function isDuplicate(key) {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
    if (seen.has(key)) return true;
    seen.set(key, now);
    return false;
}

const captionOf = (c) => (typeof c?.title === "string" ? c.title : "");

// Zalo: ảnh = chat.photo | video = chat.video.msg | file = share.file | còn lại = text/link
function classify(msgType) {
    if (msgType === "chat.photo" || msgType === "chat.gif") return "image";
    if (msgType === "chat.video.msg") return "video";
    if (msgType === "share.file") return "file";
    return "text";
}

function extractText(content) {
    if (typeof content === "string") return content;
    if (!content || typeof content !== "object") return "";
    const parts = [content.title, content.description, content.href].filter((s) => typeof s === "string" && s.trim());
    const text = [...new Set(parts)].join("\n");

    // Thẻ xem trước link dính từ khóa (vd 90land.vn) => bỏ nguyên tin, tránh gửi thêm 1 tin thừa
    const keys = removeKeywords.map(fold).filter(Boolean);
    return keys.some((k) => fold(text).includes(k)) ? "" : text;
}

// Mỗi loại media -> { kind, caption, ready: Promise }
const mediaBuilders = {
    image(content) {
        const p = parseJSON(content?.params);
        const urls = [p.hd, p.rawUrl, content?.href, content?.thumb].filter(Boolean);
        return urls.length && { kind: "image", caption: captionOf(content), ready: downloadMedia(urls, ".jpg") };
    },
    video(content) {
        if (!content?.href) return null;
        const p = parseJSON(content.params);
        return {
            kind: "video",
            caption: captionOf(content),
            ready: Promise.resolve({
                videoUrl: content.href,
                thumbnailUrl: content.thumb || "",
                duration: Number(p.duration) || 0,
                width: Number(p.video_width) || 1280,
                height: Number(p.video_height) || 720
            })
        };
    },
    file(content) {
        if (!content?.href) return null;
        const ext = path.extname(content.title || "").toLowerCase() || ".bin";
        return { kind: "file", caption: "", ready: downloadMedia(content.href, ext, ext) };
    }
};

// ==================================================
// HÀNG ĐỢI TUẦN TỰ - giữ đúng thứ tự: chữ -> ảnh -> chữ
// Mỗi nhóm chính có 1 danh sách entries theo thứ tự nhận tin.
//  - "text"  : gửi ngay khi tới lượt
//  - "media" : gom ảnh/video liền nhau CỦA CÙNG 1 NGƯỜI GỬI, gửi khi đóng cụm
//              (đóng khi có tin chữ / người khác gửi ảnh, hoặc hết MEDIA_GROUP_WAIT)
// ==================================================

const states = new Map();

function getState(id) {
    if (!states.has(id)) states.set(id, { entries: [], timer: null });
    return states.get(id);
}

function closeOpenMedia(state) {
    clearTimeout(state.timer);
    state.timer = null;
    const last = state.entries.at(-1);
    if (last?.type === "media") last.closed = true;
}

function enqueueText(mainId, subIds, text, it, rec) {
    const state = getState(mainId);
    closeOpenMedia(state); // đóng cụm ảnh để ảnh được gửi TRƯỚC chữ này
    state.entries.push({ type: "text", text, subIds, track: it, rec });
    drain(mainId);
}

function enqueueMedia(mainId, subIds, item, sender) {
    const state = getState(mainId);
    item.ready.catch(() => {}); // lỗi tải xử lý lúc gửi

    const sig = `${subIds.join(",")}|${sender}`;
    let last = state.entries.at(-1);
    if (last?.type !== "media" || last.closed || last.sig !== sig) {
        if (last?.type === "media") last.closed = true; // người khác gửi ảnh => tách cụm
        last = { type: "media", items: [], closed: false, subIds, sig };
        state.entries.push(last);
        drain(mainId); // cụm cũ vừa đóng được gửi ngay
    }
    last.items.push(item);

    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        closeOpenMedia(state);
        drain(mainId);
    }, MEDIA_GROUP_WAIT);
}

// Chuyển các tin đã sẵn sàng (theo đúng thứ tự) sang hàng đợi của từng nhóm phụ.
// Không chờ gửi xong nên tin sau không bị tin trước làm chậm.
function drain(mainId) {
    const state = getState(mainId);
    while (state.entries.length) {
        const entry = state.entries[0];
        if (entry.type === "media" && !entry.closed) break; // chờ thêm ảnh

        state.entries.shift();
        try {
            if (entry.type === "text") dispatchText(entry);
            else dispatchMedia(entry);
        } catch (err) {
            console.error("❌ Lỗi khi gửi:", err);
            const its = entry.type === "text" ? [entry.track] : entry.items.map((i) => i.track);
            its.forEach((t) => finish(t, "failed", err.message));
        }
    }
}

// ==================================================
// GỬI - mỗi nhóm phụ có 1 hàng đợi riêng (đúng thứ tự trong nhóm đó),
// các nhóm phụ chạy song song, nhóm nào chậm không làm chậm nhóm khác.
// ==================================================

const subChains = new Map(); // subId -> Promise (đuôi hàng đợi)

function enqueueForSub(subId, task) {
    const next = (subChains.get(subId) || Promise.resolve())
        .then(task)
        .catch((err) => console.error(`❌ Lỗi nhóm ${subId}:`, err.message));
    subChains.set(subId, next);
    return next;
}

const recentText = new Map();
function isRecentText(subId, text) {
    if (text.length < 20) return false; // tin ngắn kiểu "ok" thì vẫn gửi
    const now = Date.now();
    for (const [k, t] of recentText) if (now - t > TEXT_DUP_WINDOW) recentText.delete(k);
    const k = `${subId}|${createHash("md5").update(text).digest("hex")}`;
    if (recentText.has(k)) return true;
    recentText.set(k, now);
    return false;
}

// ==================================================
// THU HỒI: nhóm chính thu hồi tin => thu hồi luôn bản đã chuyển ở các nhóm phụ
// (cần selfListen để lấy cliMsgId; tool phải đang chạy lúc tin bị thu hồi)
// ==================================================

const echoCli = new Map(); // msgId -> cliMsgId của tin do chính tool gửi (dội về qua selfListen)
function rememberEcho(data) {
    if (!data?.msgId || !data?.cliMsgId) return;
    echoCli.set(String(data.msgId), String(data.cliMsgId));
    if (echoCli.size > 8000) echoCli.delete(echoCli.keys().next().value);
}

// Mỗi tin của nhóm chính có 1 bản ghi: đã gửi những tin nào ở nhóm phụ nào
const forwardIndex = new Map(); // "m:<msgId>" | "c:<cliMsgId>" -> record
function makeRecord(mainId, data, it) {
    const keys = [data.msgId && `m:${data.msgId}`, data.cliMsgId && `c:${data.cliMsgId}`].filter(Boolean);
    if (!keys.length) return null;
    const rec = { mainId, preview: it.preview, subs: [], cancelled: false, text: "", targets: [] };
    keys.forEach((k) => forwardIndex.set(k, rec));
    while (forwardIndex.size > 6000) forwardIndex.delete(forwardIndex.keys().next().value);
    return rec;
}

function collectIds(res) {
    const ids = [];
    if (res?.message?.msgId) ids.push(String(res.message.msgId));
    for (const a of res?.attachment || []) if (a?.msgId) ids.push(String(a.msgId));
    if (!ids.length && res?.msgId) ids.push(String(res.msgId));
    return ids;
}

// Thu hồi các tin (msgIds) đã gửi vào 1 nhóm phụ. Trả về lỗi (hoặc null nếu ổn).
function recallInSub(subId, ids) {
    let error = null;
    return enqueueForSub(subId, async () => {
        try {
            for (const msgId of ids) {
                let cliMsgId = echoCli.get(msgId);
                for (let i = 0; !cliMsgId && i < 10; i++) { // bản dội có thể về chậm vài giây
                    await sleep(500);
                    cliMsgId = echoCli.get(msgId);
                }
                if (!cliMsgId) throw new Error(`chưa lấy được cliMsgId của tin ${msgId}`);
                await withSendSlot(() => withRetry(() => api.undo({ msgId, cliMsgId }, subId, ThreadType.Group)));
                await sleep(SEND_GAP);
            }
        } catch (err) {
            error = err;
            console.error(`❌ Lỗi thu hồi ở nhóm ${subId}:`, err.message);
        }
    }).then(() => error);
}

function recordSent(rec, subId, ids) {
    if (!rec || !ids.length) return;
    rec.subs.push({ subId, ids });
    if (rec.cancelled) recallInSub(subId, ids); // nhóm chính đã thu hồi giữa lúc đang gửi => thu hồi ngay
}

function handleRecall(rec) {
    if (rec.cancelled) return;
    rec.cancelled = true;

    // cho phép gửi lại đúng nội dung chữ đó sau khi thu hồi (không bị coi là trùng)
    if (rec.text) {
        const h = createHash("md5").update(rec.text).digest("hex");
        for (const id of rec.targets) recentText.delete(`${id}|${h}`);
    }

    const sent = rec.subs.slice();
    const it = track(rec.mainId, "recall", `Thu hồi: ${rec.preview || ""}`, [...new Set(sent.map((x) => x.subId))]);
    if (!sent.length) return finish(it, "skipped", "chưa gửi sang nhóm phụ nên chỉ hủy gửi");

    it.state = "sending";
    it.total = sent.length;
    let failed = 0,
        firstErr = "";
    Promise.all(
        sent.map(async (x) => {
            const err = await recallInSub(x.subId, x.ids);
            if (err) {
                failed++;
                firstErr ||= err.message;
            } else it.done++;
        })
    ).then(() => (failed ? finish(it, "failed", `${it.done}/${sent.length} - ${firstErr}`) : finish(it, "done")));
}

// ==================================================
// GỬI
// ==================================================

function dispatchText({ text, subIds, track: it, rec }) {
    if (rec?.cancelled) return finish(it, "skipped", "đã thu hồi ở nhóm chính, không gửi");

    const targets = subIds.filter((id) => !isRecentText(id, text));
    if (!targets.length) return finish(it, "skipped", "trùng nội dung vừa gửi");
    if (rec) Object.assign(rec, { text, targets });

    it.state = "sending";
    it.total = targets.length;
    let failed = 0,
        firstErr = "";

    const jobs = targets.map((id) =>
        enqueueForSub(id, async () => {
            if (rec?.cancelled) return; // nhóm chính đã thu hồi trước khi kịp gửi
            try {
                const res = await withSendSlot(() => withRetry(() => api.sendMessage({ msg: text }, id, ThreadType.Group)));
                recordSent(rec, id, collectIds(res));
                it.done++;
            } catch (err) {
                failed++;
                firstErr ||= err.message;
                console.error(`❌ Lỗi gửi text đến ${id}:`, err.message);
            }
            await sleep(SEND_GAP);
        })
    );

    Promise.all(jobs).then(() => {
        if (rec?.cancelled) return finish(it, "skipped", it.done ? "đã chuyển rồi thu hồi theo nhóm chính" : "đã thu hồi ở nhóm chính, không gửi");
        failed ? finish(it, "failed", `${it.done}/${targets.length} nhóm - ${firstErr}`) : finish(it, "done");
    });
}

// Gửi 1 phần ảnh/file (chia lô), ghi nhận mã tin của từng ảnh để thu hồi đúng ảnh
async function sendFiles(part, groupId) {
    const { files, items, caption } = part;
    for (let i = 0; i < files.length; i += ALBUM_MAX) {
        const idx = [];
        for (let j = i; j < Math.min(i + ALBUM_MAX, files.length); j++) if (!items[j].rec?.cancelled) idx.push(j); // bỏ ảnh đã bị thu hồi
        if (!idx.length) continue;

        const res = await withSendSlot(() =>
            withRetry(() =>
                api.sendMessage({ msg: i === 0 ? caption || "" : "", attachments: idx.map((j) => files[j]) }, groupId, ThreadType.Group)
            )
        );

        const att = (res?.attachment || []).map((a) => a?.msgId).filter(Boolean).map(String);
        const textId = res?.message?.msgId ? String(res.message.msgId) : null;
        if (att.length === idx.length) {
            idx.forEach((j, k) => recordSent(items[j].rec, groupId, [att[k], ...(k === 0 && textId ? [textId] : [])]));
        } else {
            idx.forEach((j) => recordSent(items[j].rec, groupId, collectIds(res))); // không khớp 1-1 => gắn cả lô
        }
        await sleep(SEND_GAP);
    }
}

// Tải xong các file của cụm và dựng danh sách phần cần gửi (làm 1 lần, dùng chung cho mọi nhóm phụ)
async function prepareMedia(items) {
    const tempFiles = [];
    const parts = []; // giữ đúng thứ tự như nhóm chính
    const captions = new Set();
    const okItems = [];

    try {
        const settled = await Promise.allSettled(items.map((i) => i.ready));
        items.forEach((item, idx) => {
            const r = settled[idx];
            if (r.status === "rejected") {
                console.error(`❌ Bỏ qua 1 ${item.kind} vì tải lỗi:`, r.reason?.message);
                return finish(item.track, "failed", "tải lỗi: " + r.reason?.message);
            }
            okItems.push(item);

            const cap = cleanText(item.caption || "");
            if (cap) captions.add(cap);

            if (item.kind === "video") return parts.push({ type: "video", info: r.value, items: [item] });

            tempFiles.push(r.value);
            const last = parts.at(-1);
            if (item.kind === "image" && last?.type === "images") {
                last.files.push(r.value); // ảnh liền nhau => album
                last.items.push(item);
            } else {
                parts.push({ type: item.kind === "image" ? "images" : "file", files: [r.value], items: [item] });
            }
        });
        if (parts.length) parts[0].caption = [...captions].join("\n"); // chú thích chỉ gắn vào phần đầu
    } catch (err) {
        items.forEach((i) => finish(i.track, "failed", err.message));
        return { parts: [], okItems: [], tempFiles };
    }
    return { parts, okItems, tempFiles };
}

function dispatchMedia({ items: all, subIds }) {
    // tin đã bị thu hồi ở nhóm chính trước khi kịp gửi => bỏ, dọn file tạm
    const items = all.filter((i) => !i.rec?.cancelled);
    all.filter((i) => i.rec?.cancelled).forEach((i) => {
        finish(i.track, "skipped", "đã thu hồi ở nhóm chính, không gửi");
        if (i.kind !== "video") i.ready.then((f) => fs.promises.unlink(f).catch(() => {})).catch(() => {});
    });
    if (!items.length) return;

    log(`\n📦 CỤM MEDIA (${items.length} mục) → ${subIds.length} nhóm`);
    items.forEach((i) => {
        i.track.state = "sending";
        i.track.total = subIds.length;
    });

    const prepared = prepareMedia(items);
    let groupsOk = 0,
        remaining = subIds.length;

    for (const subId of subIds) {
        enqueueForSub(subId, async () => {
            const { parts, okItems } = await prepared;
            let ok = parts.length > 0;

            for (const part of parts) {
                try {
                    if (part.type === "video") {
                        const item = part.items[0];
                        if (item.rec?.cancelled) continue;
                        const res = await withSendSlot(() => withRetry(() => api.sendVideo({ ...part.info, msg: part.caption || "" }, subId, ThreadType.Group)));
                        recordSent(item.rec, subId, collectIds(res));
                    } else {
                        await sendFiles(part, subId);
                    }
                } catch (err) {
                    ok = false;
                    console.error(`❌ Lỗi gửi ${part.type} đến ${subId}:`, err.message);
                }
                await sleep(SEND_GAP);
            }
            if (ok) groupsOk++;
            okItems.forEach((i) => (i.track.done = groupsOk));
        }).then(async () => {
            if (--remaining > 0) return; // còn nhóm khác đang gửi
            const { okItems, tempFiles } = await prepared;
            okItems.forEach((i) => {
                if (i.rec?.cancelled) finish(i.track, "skipped", "đã thu hồi theo nhóm chính");
                else if (groupsOk === subIds.length) finish(i.track, "done");
                else finish(i.track, "failed", `${groupsOk}/${subIds.length} nhóm`);
            });
            await Promise.all(tempFiles.map((f) => fs.promises.unlink(f).catch(() => {})));
        });
    }
}

// ==================================================
// LẮNG NGHE TIN NHẮN
// ==================================================

function processMessage(mainId, subIds, data) {
    const kind = classify(String(data.msgType || ""));

    if (kind === "text") {
        if (!TEXT_TYPES.has(String(data.msgType))) {
            const skipped = track(mainId, "text", `(${data.msgType})`, subIds);
            return finish(skipped, "skipped", `loại tin chưa hỗ trợ (${data.msgType})`);
        }
        const raw = extractText(data.content);
        const it = track(mainId, "text", oneLine(raw) || `(${data.msgType})`, subIds);

        if (!raw.trim()) return finish(it, "skipped", `loại tin không chuyển (${data.msgType})`);

        const why = blockedReason(raw);
        if (why) return finish(it, "skipped", "bị chặn: " + why);

        const text = cleanText(raw);
        if (!text) return finish(it, "skipped", "rỗng sau khi xóa dòng thừa");

        return enqueueText(mainId, subIds, text, it, makeRecord(mainId, data, it));
    }

    const content = data.content;
    const label =
        kind === "file" ? content?.title || "File" : (kind === "image" ? "Ảnh" : "Video") + (captionOf(content) ? ": " + oneLine(captionOf(content), 40) : "");
    const it = track(mainId, kind, label, subIds);

    const item = mediaBuilders[kind](content);
    if (!item) return finish(it, "failed", `không tìm thấy đường dẫn ${kind}`);

    item.track = it;
    item.rec = makeRecord(mainId, data, it);
    enqueueMedia(mainId, subIds, item, String(data.uidFrom ?? ""));
}

api.listener.on("message", (message) => {
    if (message.type !== ThreadType.Group) return;
    if (message.isSelf) return rememberEcho(message.data); // tin do chính tool gửi dội về: lưu cliMsgId để thu hồi

    const mainId = message.threadId;
    const subIds = ruleMap.get(mainId);
    if (!subIds) return;

    const data = message.data || {};
    const key = messageKey(data);
    if (key && isDuplicate(`${mainId}:${key}`)) return log("⚠️ Bỏ qua tin trùng:", data.msgId);

    log(`📩 Tin mới | ${mainId} | ${data.msgType}`);
    try {
        processMessage(mainId, subIds, data);
    } catch (err) {
        console.error("❌ LỖI XỬ LÝ TIN NHẮN:", err);
    }
});

api.listener.on("undo", (undo) => {
    try {
        if (undo?.isSelf) return;
        const mainId = undo?.threadId || undo?.data?.idTo;
        if (!ruleMap.has(mainId)) return;

        const c = undo.data?.content || {};
        const keys = [c.globalMsgId && `m:${c.globalMsgId}`, undo.data?.realMsgId && `m:${undo.data.realMsgId}`, c.cliMsgId && `c:${c.cliMsgId}`].filter(Boolean);
        const rec = keys.map((k) => forwardIndex.get(k)).find(Boolean);

        if (!rec) return log("↩️ Nhóm chính thu hồi 1 tin tool không có bản ghi (chưa chuyển hoặc đã khởi động lại), bỏ qua");
        log("↩️ Nhóm chính thu hồi tin:", rec.preview);
        handleRecall(rec);
    } catch (err) {
        console.error("❌ Lỗi xử lý thu hồi:", err.message);
    }
});

api.listener.on("connected", () => {
    connection = "connected";
    log("🔌 Đã kết nối Zalo");
});
api.listener.on("error", (err) => console.error("❌ Lỗi listener:", err?.message || err));
api.listener.on("closed", (code, reason) => {
    connection = "disconnected";
    console.warn(`⚠️ Mất kết nối Zalo (code ${code}${reason ? ", " + reason : ""})`);
    if (code === 3000) console.warn("   → Zalo đang được mở ở nơi khác (Zalo Web / cửa sổ tool khác). Hãy đóng nó rồi chạy lại tool.");
});

process.on("unhandledRejection", (err) => console.error("❌ Lỗi không bắt được:", err?.message || err));

api.listener.start({ retryOnClose: true }); // tự nối lại khi rớt mạng
log("👂 ĐANG CHỜ TIN NHẮN ZALO...");