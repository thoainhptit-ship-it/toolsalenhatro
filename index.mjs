import express from "express";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Zalo, ThreadType } from "zca-js";

const PORT = 3000;
const MEDIA_GROUP_WAIT = 2000; // gom ảnh/video gửi liên tiếp thành 1 cụm (ms)
const CONFIG_FILE = path.join(process.cwd(), "config.json");
const TEMP_DIR = path.join(process.cwd(), "temp_media");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ==================================================
// KHỞI TẠO
// ==================================================

fs.rmSync(TEMP_DIR, { recursive: true, force: true }); // dọn file tạm còn sót
fs.mkdirSync(TEMP_DIR, { recursive: true });

async function imageMetadataGetter(filePath) {
    try {
        const data = await fs.promises.readFile(filePath);
        const { width, height } = await sharp(data).metadata();
        return { width: width || 720, height: height || 720, size: data.length };
    } catch {
        return { width: 720, height: 720, size: 10000 };
    }
}

log("\n⏳ ĐANG ĐĂNG NHẬP ZALO...");
const api = await new Zalo({ imageMetadataGetter }).loginQR();
log("✅ Đăng nhập Zalo thành công!\n");

// ==================================================
// DANH SÁCH NHÓM (có ảnh đại diện)
// ==================================================

async function loadGroups() {
    const list = [];
    try {
        const all = await api.getAllGroups();
        const ids = Object.keys(all.gridVerMap || {});
        log("⏳ Đang lấy thông tin", ids.length, "nhóm...");

        // Lấy theo lô, chạy song song cho nhanh
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
// CẤU HÌNH (lưu vào config.json, tự nạp lại khi khởi động)
// ==================================================

let rules = [];
let removeKeywords = ["🌹", "🚩", "90land.vn"]; // dòng nào chứa từ khóa này sẽ bị xóa khỏi tin
let ruleMap = new Map(); // mainGroupId -> subGroupIds[]

function applyRules(input) {
    rules = (Array.isArray(input) ? input : [])
        .filter((r) => r && typeof r.mainGroupId === "string")
        .map((r) => ({
            mainGroupId: r.mainGroupId,
            subGroupIds: [...new Set(r.subGroupIds || [])].filter((id) => id && id !== r.mainGroupId)
        }));
    ruleMap = new Map(rules.filter((r) => r.mainGroupId && r.subGroupIds.length).map((r) => [r.mainGroupId, r.subGroupIds]));
}

function applyConfig(cfg) {
    const c = Array.isArray(cfg) ? { rules: cfg } : cfg || {}; // tương thích file config cũ
    applyRules(c.rules);
    if (Array.isArray(c.removeKeywords)) {
        removeKeywords = c.removeKeywords.map((k) => String(k).trim()).filter(Boolean);
    }
}

try {
    applyConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
    log("✅ Đã nạp cấu hình:", ruleMap.size, "nhóm chính");
} catch {}

// ==================================================
// WEB + API
// ==================================================

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/api/groups", (_req, res) => res.json(groupsList));
app.get("/api/config", (_req, res) => res.json({ rules, removeKeywords }));
app.post("/api/config", async (req, res) => {
    applyConfig(req.body);
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify({ rules, removeKeywords }, null, 2));
    res.json({ success: true });
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

const KNOWN_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);

function extFromUrl(url, fallback) {
    try {
        const ext = path.extname(new URL(url).pathname).toLowerCase();
        if (KNOWN_EXT.has(ext)) return ext;
    } catch {}
    return fallback;
}

async function downloadMedia(url, fallbackExt = ".jpg", forceExt = null) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ext = forceExt || extFromUrl(url, fallbackExt);
    const filePath = path.join(TEMP_DIR, `media_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
    return filePath;
}

// Xóa các dòng chứa từ khóa (không phân biệt hoa/thường, kể cả chữ in đậm kiểu 𝐌𝐀̃),
// rồi gộp các dòng trống liên tiếp thành 1
const fold = (s) => s.normalize("NFKC").toLowerCase();

function cleanText(text) {
    const keys = removeKeywords.map(fold).filter(Boolean);
    return text
        .split("\n")
        .filter((line) => !keys.some((k) => fold(line).includes(k)))
        .join("\n")
        .replace(/\n[ \t]*(\n[ \t]*)+/g, "\n\n")
        .trim();
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
    return [...new Set(parts)].join("\n");
}

// Mỗi loại media -> { kind, caption, ready: Promise } hoặc null nếu thiếu URL
const mediaBuilders = {
    image(content) {
        const p = parseJSON(content?.params);
        const url = p.hd || p.rawUrl || content?.href || content?.thumb;
        return url && { kind: "image", caption: captionOf(content), ready: downloadMedia(url, ".jpg") };
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
//  - "media" : gom ảnh/video liền nhau, gửi khi đóng cụm
//              (có chữ đến sau, hoặc hết MEDIA_GROUP_WAIT)
// ==================================================

const states = new Map();

function getState(id) {
    if (!states.has(id)) states.set(id, { entries: [], processing: false, timer: null });
    return states.get(id);
}

function closeOpenMedia(state) {
    clearTimeout(state.timer);
    state.timer = null;
    const last = state.entries.at(-1);
    if (last?.type === "media") last.closed = true;
}

function enqueueText(mainId, subIds, text) {
    const state = getState(mainId);
    closeOpenMedia(state); // đóng cụm ảnh để ảnh được gửi TRƯỚC chữ này
    state.entries.push({ type: "text", text, subIds });
    drain(mainId);
}

function enqueueMedia(mainId, subIds, item) {
    const state = getState(mainId);
    item.ready.catch(() => {}); // lỗi tải sẽ xử lý lúc gửi

    let last = state.entries.at(-1);
    if (last?.type !== "media" || last.closed) {
        last = { type: "media", items: [], closed: false, subIds };
        state.entries.push(last);
    }
    last.items.push(item);

    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        closeOpenMedia(state);
        drain(mainId);
    }, MEDIA_GROUP_WAIT);
}

async function drain(mainId) {
    const state = getState(mainId);
    if (state.processing) return;
    state.processing = true;

    try {
        while (state.entries.length) {
            const entry = state.entries[0];
            if (entry.type === "media" && !entry.closed) break; // chờ thêm ảnh

            state.entries.shift();
            try {
                if (entry.type === "text") await sendText(entry);
                else await sendMedia(entry);
            } catch (err) {
                console.error("❌ Lỗi khi gửi:", err);
            }
        }
    } finally {
        state.processing = false;
    }
}

// ==================================================
// GỬI
// ==================================================

async function sendText({ text, subIds }) {
    log("→ Gửi TEXT:", text.slice(0, 60));
    const results = await Promise.allSettled(subIds.map((id) => api.sendMessage({ msg: text }, id, ThreadType.Group)));
    results.forEach((r, i) => r.status === "rejected" && console.error(`❌ Lỗi gửi text đến ${subIds[i]}:`, r.reason?.message));
}

async function sendVideo(v, groupId, caption, tempFiles) {
    try {
        await api.sendVideo({ ...v, msg: caption || "" }, groupId, ThreadType.Group);
    } catch (err) {
        console.error("❌ sendVideo lỗi:", err.message, "→ gửi dạng file");
        const file = await downloadMedia(v.videoUrl, ".mp4", ".mp4");
        tempFiles.push(file);
        await api.sendMessage({ msg: "", attachments: [file] }, groupId, ThreadType.Group);
    }
}

async function sendMedia({ items, subIds }) {
    log(`\n📦 GỬI CỤM MEDIA (${items.length} mục) → ${subIds.length} nhóm`);

    const tempFiles = [];
    const parts = []; // giữ đúng thứ tự như nhóm chính
    const captions = new Set();
    const settled = await Promise.allSettled(items.map((i) => i.ready));

    items.forEach((item, idx) => {
        const r = settled[idx];
        if (r.status === "rejected") return console.error(`❌ Bỏ qua 1 ${item.kind} vì tải lỗi:`, r.reason?.message);

        const cap = cleanText(item.caption || "");
        if (cap) captions.add(cap);

        if (item.kind === "video") return parts.push({ type: "video", info: r.value });

        tempFiles.push(r.value);
        const last = parts.at(-1);
        if (item.kind === "image" && last?.type === "images") last.files.push(r.value); // ảnh liền nhau => album
        else parts.push(item.kind === "image" ? { type: "images", files: [r.value] } : { type: "file", files: [r.value] });
    });

    if (parts.length) parts[0].caption = [...captions].join("\n"); // chú thích chỉ gắn vào phần đầu

    for (const groupId of subIds) {
        for (const part of parts) {
            try {
                if (part.type === "video") await sendVideo(part.info, groupId, part.caption, tempFiles);
                else await api.sendMessage({ msg: part.caption || "", attachments: part.files }, groupId, ThreadType.Group);
                log(`✅ ${groupId}: đã gửi ${part.type}`);
            } catch (err) {
                console.error(`❌ Lỗi gửi ${part.type} đến ${groupId}:`, err.message);
            }
            await sleep(300);
        }
    }

    await Promise.all(tempFiles.map((f) => fs.promises.unlink(f).catch(() => {})));
}

// ==================================================
// LẮNG NGHE TIN NHẮN
// ==================================================

api.listener.on("message", (message) => {
    if (message.type !== ThreadType.Group || message.isSelf) return;

    const mainId = message.threadId;
    const subIds = ruleMap.get(mainId);
    if (!subIds) return;

    const data = message.data || {};
    const kind = classify(String(data.msgType || ""));
    log(`📩 Tin mới | ${mainId} | ${data.msgType} | ${kind}`);

    try {
        if (kind === "text") {
            const text = cleanText(extractText(data.content));
            if (text) enqueueText(mainId, subIds, text);
            return;
        }

        const item = mediaBuilders[kind](data.content);
        if (item) enqueueMedia(mainId, subIds, item);
        else log(`⚠️ Không tìm thấy URL ${kind}`);
    } catch (err) {
        console.error("❌ LỖI XỬ LÝ TIN NHẮN:", err);
    }
});

api.listener.start();
log("👂 ĐANG CHỜ TIN NHẮN ZALO...");