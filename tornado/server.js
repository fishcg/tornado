import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import OpenAI from "../node_modules/openai/index.js";
import OSS from "../node_modules/ali-oss/lib/client.js";
import { getDb, closeDb, initDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ──────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.TORNADO_PORT || 3011);
const MEMORY_API = process.env.MEMORY_API || "http://localhost:8880";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY || "";
const OPENAI_API_URL =
  process.env.TORNADO_API_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const OPENAI_MODEL = process.env.TORNADO_MODEL || process.env.OPENAI_MODEL || "deepseek-v3.2";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const IMAGE_API_URL = process.env.IMAGE_API_URL || "https://api.test.ai/openapi/v1/generate";
const IMAGE_API_KEY = process.env.IMAGE_API_KEY || "";
const SOUL_PATH = path.join(__dirname, "soul.md");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");
// 主动发消息：空闲多久后触发（分钟），可通过环境变量覆盖
const PROACTIVE_IDLE_MINUTES = Number(process.env.PROACTIVE_IDLE_MINUTES || 30);
const WEATHER_CITY = process.env.WEATHER_CITY || "";
const PASSWORD_SALT = process.env.PASSWORD_SALT || "tornado-default-salt-2025";
const DEFAULT_INVITE_CODE = process.env.DEFAULT_INVITE_CODE || "tornado2025";

const OSS_REGION = process.env.OSS_REGION || "";
const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || "";
const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || "";
const OSS_BUCKET = process.env.OSS_BUCKET || "";
const OSS_BASE_URL = process.env.OSS_BASE_URL || "";

function getOssClient() {
  return new OSS({
    region: OSS_REGION,
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET
  });
}

async function uploadToOss(buffer, filename, mimeType) {
  const client = getOssClient();
  const opts = mimeType ? { mime: mimeType } : {};
  await client.put(`tornado/${filename}`, buffer, opts);
  return `${OSS_BASE_URL}/tornado/${filename}`;
}

// ── 鉴权 ──────────────────────────────────────────────────────────────────────

const authSessions = new Map(); // sid -> { userId, username }  内存缓存

function hashPassword(password) {
  return crypto.createHash("sha256").update(password + PASSWORD_SALT).digest("hex");
}

async function loadAuthSession(sid) {
  if (!sid) return null;
  const cached = authSessions.get(sid);
  if (cached) return cached;
  const row = await dbGet("SELECT user_id, username FROM auth_sessions WHERE sid = ?", [sid]);
  if (!row) return null;
  const sess = { userId: row.user_id, username: row.username };
  authSessions.set(sid, sess);
  return sess;
}

async function createAuthSession(userId, username) {
  const sid = crypto.randomBytes(32).toString("hex");
  const sess = { userId, username };
  authSessions.set(sid, sess);
  await dbRun("INSERT INTO auth_sessions (sid, user_id, username, created_at) VALUES (?, ?, ?, ?)",
    [sid, userId, username, nowIso()]);
  return sid;
}

async function deleteAuthSession(sid) {
  if (!sid) return;
  authSessions.delete(sid);
  await dbRun("DELETE FROM auth_sessions WHERE sid = ?", [sid]);
}

async function getAuthSession(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth) {
    const m = auth.match(/^Bearer\s+([A-Za-z0-9]+)$/i);
    if (m) {
      const sess = await loadAuthSession(m[1]);
      if (sess) return sess;
    }
  }
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!match) return null;
  return await loadAuthSession(match[1]);
}

async function requireAuth(req, res) {
  const session = await getAuthSession(req);
  if (!session) { send(res, 401, { error: "unauthorized" }); return null; }
  return session;
}

async function requireAdmin(req, res) {
  const session = await getAuthSession(req);
  if (!session) { send(res, 401, { error: "unauthorized" }); return null; }
  const user = await dbGet("SELECT is_admin FROM users WHERE id = ?", [session.userId]);
  if (!user?.is_admin) { send(res, 403, { error: "forbidden" }); return null; }
  return session;
}

async function getGlobalSetting(key, defaultValue = null) {
  const row = await dbGet("SELECT value FROM global_settings WHERE `key` = ?", [key]);
  return row ? row.value : defaultValue;
}

async function setGlobalSetting(key, value) {
  await dbRun("INSERT INTO global_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=?", [key, String(value), String(value)]);
}

// ── MySQL 辅助函数 ─────────────────────────────────────────────────────────────

async function dbGet(sql, params = []) {
  const [rows] = await getDb().execute(sql, params);
  return rows[0] ?? null;
}

async function dbAll(sql, params = []) {
  const [rows] = await getDb().execute(sql, params);
  return rows;
}

async function dbRun(sql, params = []) {
  const [result] = await getDb().execute(sql, params);
  return result;
}

// ── 用户设置（替代 globalSettings 文件）────────────────────────────────────────

// flags bit layout: bit0=imageFallback, bit1=chatImage, bit2=imageAutoExpand, bit3=collapseAction, bit4=ttsEnabled
const FLAG_IMAGE_FALLBACK  = 1;
const FLAG_CHAT_IMAGE      = 2;
const FLAG_IMAGE_AUTOEXPAND = 4;
const FLAG_COLLAPSE_ACTION = 8;
const FLAG_TTS_ENABLED     = 16;
const FLAGS_DEFAULT        = FLAG_CHAT_IMAGE; // 0b0010 = 2

async function getUserSettings(userId) {
  const row = await dbGet("SELECT * FROM user_settings WHERE user_id = ?", [userId]);
  const globalImageEnabled = (await getGlobalSetting("chat_image_enabled", "1")) !== "0";
  const manualAffectionEnabled = (await getGlobalSetting("manual_affection_enabled", "1")) !== "0";
  const flags = row ? (row.flags ?? FLAGS_DEFAULT) : FLAGS_DEFAULT;
  const base = {
    imageFallbackEnabled: !!(flags & FLAG_IMAGE_FALLBACK),
    chatImageEnabled:     !!(flags & FLAG_CHAT_IMAGE),
    imageAutoExpand:      !!(flags & FLAG_IMAGE_AUTOEXPAND),
    collapseAction:       !!(flags & FLAG_COLLAPSE_ACTION),
    ttsEnabled:           !!(flags & FLAG_TTS_ENABLED),
    ttsLang:              row?.tts_lang || "zh",
    llmProvider:          row?.llm_provider || "deepseek",
    manualAffectionEnabled,
  };
  if (!globalImageEnabled) base.chatImageEnabled = false;
  return base;
}

async function saveUserSettings(userId, patch) {
  await dbRun(`INSERT IGNORE INTO user_settings (user_id, flags) VALUES (?, ?)`, [userId, FLAGS_DEFAULT]);
  const flagMap = {
    imageFallbackEnabled: FLAG_IMAGE_FALLBACK,
    chatImageEnabled:     FLAG_CHAT_IMAGE,
    imageAutoExpand:      FLAG_IMAGE_AUTOEXPAND,
    collapseAction:       FLAG_COLLAPSE_ACTION,
    ttsEnabled:           FLAG_TTS_ENABLED,
  };
  for (const [key, bit] of Object.entries(flagMap)) {
    if (key in patch) {
      if (patch[key]) {
        await dbRun("UPDATE user_settings SET flags = flags | ? WHERE user_id = ?", [bit, userId]);
      } else {
        await dbRun("UPDATE user_settings SET flags = flags & ? WHERE user_id = ?", [~bit, userId]);
      }
    }
  }
  if ("llmProvider" in patch && patch.llmProvider !== undefined) {
    await dbRun("UPDATE user_settings SET llm_provider = ? WHERE user_id = ?", [patch.llmProvider, userId]);
  }
  if ("ttsLang" in patch && patch.ttsLang !== undefined) {
    const lang = ["zh", "ja"].includes(patch.ttsLang) ? patch.ttsLang : "zh";
    await dbRun("UPDATE user_settings SET tts_lang = ? WHERE user_id = ?", [lang, userId]);
    // 语言变了，清除缓存的试听音频
    await dbRun("UPDATE characters SET voice_preview_url = NULL WHERE user_id = ?", [userId]);
  }
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_API_URL
});

// DeepSeek 官方 API，用于主聊天对话
const deepseek = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: DEEPSEEK_API_URL
});

// NewAPI — 仅 admin 可使用
const NEWAPI_API_KEY = process.env.NEWAPI_API_KEY || "";
const NEWAPI_MODEL = process.env.NEWAPI_MODEL || "grok-4.20-0309";
const newapi = new OpenAI({
  apiKey: NEWAPI_API_KEY,
  baseURL: "https://api.glmbigmodel.me/v1"
});

// ── 工具 ──────────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function nowLocal() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function toLocal(isoStr) {
  if (!isoStr) return isoStr;
  return new Date(isoStr).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function loadSoulFromFile() {
  if (!fs.existsSync(SOUL_PATH)) return null;
  return fs.readFileSync(SOUL_PATH, "utf8").trim();
}

async function getActiveCharacter(userId) {
  try {
    if (userId != null) {
      const row = await dbGet("SELECT * FROM characters WHERE is_active = 1 AND user_id = ? LIMIT 1", [userId]);
      if (row) return row;
    } else {
      const row = await dbGet("SELECT * FROM characters WHERE is_active = 1 LIMIT 1", []);
      if (row) return row;
    }
  } catch {}
  return null;
}

// 把结构化字段 + soul_content 拼成完整 soul 字符串传给 LLM
function buildSoulText(char) {
  const parts = [];
  if (char.name) parts.push(`# 角色名称\n\n${char.name}`);
  if (char.appearance) parts.push(`# 外貌\n\n${char.appearance}`);
  if (char.personality) parts.push(`# 性格\n\n${char.personality}`);
  if (char.description) parts.push(`# 人物说明\n\n${char.description}`);
  if (char.soul_content) parts.push(char.soul_content.trim());
  return parts.join("\n\n");
}

async function loadSoul(userId) {
  try {
    const char = await getActiveCharacter(userId);
    if (char) return buildSoulText(char);
  } catch {}
  const fileSoul = loadSoulFromFile();
  if (fileSoul) return fileSoul;
  throw new Error(`soul.md not found`);
}

function extractSectionFromSoul(soul, header) {
  const lines = soul.split("\n");
  let inSection = false;
  const buf = [];
  for (const line of lines) {
    if (line.trim() === header) { inSection = true; continue; }
    if (inSection) {
      if (line.startsWith("#")) break;
      if (line.trim()) buf.push(line.trim());
    }
  }
  return buf.join("，") || null;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const ct = typeof body === "string" ? "text/plain; charset=utf-8" : "application/json";
  res.writeHead(status, { "Content-Type": ct, "Access-Control-Allow-Origin": "*" });
  res.end(payload);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
  if (!fs.existsSync(filePath)) {
    send(res, 404, "Not found");
    return;
  }
  // HTML 完全不缓存（含静态资源版本号），JS/CSS 用强校验避免 iOS Safari 激进缓存
  const cacheControl = ext === ".html"
    ? "no-store, no-cache, must-revalidate"
    : "no-cache, must-revalidate";
  res.writeHead(200, { "Content-Type": mime[ext] || "text/plain", "Cache-Control": cacheControl });
  fs.createReadStream(filePath).pipe(res);
}

function sendHtmlWithAssetVersion(res, htmlPath, publicDir) {
  if (!fs.existsSync(htmlPath)) {
    send(res, 404, "Not found");
    return;
  }
  let html = fs.readFileSync(htmlPath, "utf8");
  // 给 app.js / styles.css / auth.js 等本地静态资源注入 mtime 作为版本号，绕过浏览器缓存
  const assets = ["app.js", "styles.css", "auth.js"];
  for (const asset of assets) {
    const assetPath = path.join(publicDir, asset);
    if (!fs.existsSync(assetPath)) continue;
    const v = Math.floor(fs.statSync(assetPath).mtimeMs);
    const re = new RegExp(`(["'/])${asset.replace(".", "\\.")}(["'?])`, "g");
    html = html.replace(re, (m, p1, p2) => p2 === "?" ? m : `${p1}${asset}?v=${v}${p2}`);
  }
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store, no-cache, must-revalidate"
  });
  res.end(html);
}

// ── memory-ai ─────────────────────────────────────────────────────────────────

function timed(label, fn) {
  return async (...args) => {
    const t = Date.now();
    try {
      const result = await fn(...args);
      return result;
    } catch (err) {
      throw err;
    }
  };
}

// 判断当前消息是否需要查长期记忆
async function needsMemoryLookup(userText, recentMsgs) {
  return true; // 先禁用，等后续优化好了再放开

  const recentContext = recentMsgs
    .slice(-6)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
    .join("\n");

  const t0 = Date.now();
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    messages: [
      {
        role: "system",
        content:
          "你是一个判断助手。根据用户当前消息和最近对话，判断是否需要查询用户的长期记忆（过去聊天中提到的个人信息、偏好、经历等）才能更好地回答。只回复 yes 或 no，不要有其他内容。"
      },
      {
        role: "user",
        content: `最近对话：\n${recentContext || "（无）"}\n\n用户当前消息：${userText}`
      }
    ]
  });

  return (res.choices?.[0]?.message?.content || "").trim().toLowerCase().startsWith("y");
}

async function queryMemory(question, characterName, userId) {
  try {
    const params = new URLSearchParams({ q: question });
    const sourcePrefix = userId ? `tornado-${userId}-${characterName}` : (characterName ? `tornado-${characterName}` : null);
    if (sourcePrefix) params.set("source", sourcePrefix);
    const res = await fetch(`${MEMORY_API}/query?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.answer || null;
  } catch {
    return null;
  }
}

async function queryEntityGraph(characterName, userId) {
  try {
    const sourcePrefix = userId ? `tornado-${userId}-${characterName}` : (characterName ? `tornado-${characterName}` : null);
    const params = new URLSearchParams({ limit: "100" });
    if (sourcePrefix) params.set("source", sourcePrefix);
    const res = await fetch(`${MEMORY_API}/graph?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.edges?.length) return null;
    const lines = data.edges
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 30)
      .map(e => `${e.source} → ${e.relationship} → ${e.target}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function ingestToMemory(text, characterName, userId) {
  try {
    const source = userId ? `tornado-${userId}-${characterName}` : (characterName ? `tornado-${characterName}` : "tornado-chat");
    await fetch(`${MEMORY_API}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source })
    });
  } catch {}
}

// ── LLM ───────────────────────────────────────────────────────────────────────

async function llmChatStream(messages, provider = "deepseek") {
  const t0 = Date.now();
  const client = provider === "newapi" ? newapi : deepseek;
  const model = provider === "newapi" ? NEWAPI_MODEL : DEEPSEEK_MODEL;
  const createOpts = {
    model,
    messages,
    stream: true,
    max_tokens: 600
  };
  if (provider === "newapi") createOpts.enable_nsfw = true;
  if (provider === "deepseek") {
    const thinkingEnabled = (await getGlobalSetting("deepseek_thinking", "0")) === "1";
    createOpts.enable_thinking = thinkingEnabled;
    if (thinkingEnabled) createOpts.thinking_budget = 1000;
  }
  const stream = await client.chat.completions.create(createOpts);
  return { stream, t0 };
}

// ── 生图 ──────────────────────────────────────────────────────────────────────

const IMG_TAG_RE = /\[IMG:\s*(.+?)\]\s*$/;
const pendingImages = new Set();

async function getCharacterAppearance(userId) {
  try {
    const char = await getActiveCharacter(userId);
    if (char?.appearance) return char.appearance;
    // fallback: 从 soul.md 解析
    const fileSoul = loadSoulFromFile();
    if (fileSoul) return extractSectionFromSoul(fileSoul, "# 外貌") || "anime character";
  } catch {}
  return "anime character";
}

async function getCharacterDescription(userId) {
  try {
    const char = await getActiveCharacter(userId);
    if (char?.description) return char.description;
    const fileSoul = loadSoulFromFile();
    if (fileSoul) return extractSectionFromSoul(fileSoul, "# 人物说明") || "";
  } catch {}
  return "";
}

async function buildCharacterPromptPrefix(userId) {
  const appearance = (await getCharacterAppearance(userId)).slice(0, 200);
  const desc = (await getCharacterDescription(userId)).slice(0, 80);
  return desc ? `${desc}，${appearance}` : appearance;
}

function extractImageTag(text) {
  const match = text.match(IMG_TAG_RE);
  if (!match) return { cleanText: text, prompt: null };
  return { cleanText: text.replace(IMG_TAG_RE, "").trimEnd(), prompt: match[1].trim() };
}

async function callImageApiFallback(prompt, { aspectRatio = "16:9" } = {}) {
  // DashScope wanx 文生图，作为主 API 失败时的备用
  const sizeMap = { "1:1": "1024*1024", "2:3": "768*1024", "16:9": "1280*720", "9:16": "720*1280" };
  const size = sizeMap[aspectRatio] || "1024*1024";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 360_000);
  try {
    const submitRes = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model: "wanx-v1",
        input: { prompt },
        parameters: { size, n: 1, style: "<anime>" }
      }),
      signal: controller.signal
    });
    if (!submitRes.ok) {
      const body = await submitRes.text().catch(() => "");
      throw new Error(`DashScope submit ${submitRes.status}: ${body.slice(0, 200)}`);
    }
    const submitData = await submitRes.json();
    const taskId = submitData.output?.task_id;
    if (!taskId) throw new Error(`DashScope: no task_id in response`);

    // 轮询任务结果
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
      });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json();
      const status = pollData.output?.task_status;
      if (status === "SUCCEEDED") {
        const url = pollData.output?.results?.[0]?.url;
        if (!url) throw new Error("DashScope: no url in result");
        return url;
      }
      if (status === "FAILED") throw new Error(`DashScope task failed: ${JSON.stringify(pollData.output).slice(0, 200)}`);
    }
    throw new Error("DashScope: task timed out");
  } finally {
    clearTimeout(timeout);
  }
}

async function callImageApi(prompt, { hd = true, aspectRatio = "16:9" } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 360_000);
  try {
    const res = await fetch(IMAGE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${IMAGE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        mode: "txt2img",
        modelId: "gpt-image",
        n: 1,
        hd,
        aspectRatio
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Image API ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const url = data.url || data.data?.[0]?.url || data.images?.[0] || data.output?.url || null;
    if (!url) {
      throw new Error(`Image API returned no URL: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return url;
  } finally {
    clearTimeout(timeout);
  }
}

async function rewriteSafePrompt(originalPrompt) {
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    messages: [
      {
        role: "system",
        content: "用户提供的图片描述被生图API拒绝了（可能包含敏感内容）。请改写为一个安全、合规的中文图片描述，保留原始场景的核心意图但去掉所有可能违规的元素。只输出改写后的描述，不要其他内容。"
      },
      { role: "user", content: originalPrompt }
    ]
  });
  return (res.choices?.[0]?.message?.content || "").trim();
}

async function generateImage(prompt, sceneAnchor = "", { imageFallbackEnabled = true, aspectRatio = null } = {}) {
  const ratio = aspectRatio || "16:9";
  try {
    return await callImageApi(prompt, { aspectRatio: ratio });
  } catch (err) {
    if (err.status === 400) {
      console.log("生图被拒，尝试改写 prompt 重试...");
      const safePrompt = await rewriteSafePrompt(prompt);
      if (safePrompt) {
        const retryPrompt = sceneAnchor ? `${safePrompt}${sceneAnchor}` : safePrompt;
        console.log(`改写后: ${retryPrompt}`);
        try {
          return await callImageApi(retryPrompt, { aspectRatio: ratio });
        } catch (err2) {
          if (!imageFallbackEnabled) throw err2;
          console.log(`改写后仍失败，切换 DashScope 重试: ${err2.message}`);
          return await callImageApiFallback(retryPrompt, { aspectRatio: ratio });
        }
      }
    }
    if (!imageFallbackEnabled) throw err;
    console.log(`主 API 失败，切换 DashScope 重试: ${err.message}`);
    return await callImageApiFallback(prompt, { aspectRatio: ratio });
  }
}

async function recognizeImage(imageUrl) {
  try {
    const res = await fetch(IMAGE_API_URL.replace("/generate", "/understand"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${IMAGE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ action: "recognize-scene", imageUrl })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    return data.description || null;
  } catch {
    return null;
  }
}

async function generateImagePrompt(userText, assistantReply, recentMsgs, previousScene, userId) {
  const charName = await getCharacterName(userId);
  const context = recentMsgs.slice(-6).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    messages: [
      {
        role: "system",
        content: [
          `根据对话上下文，生成一段简短的中文图片描述，用于生成角色${charName}的照片。`,
          "描述要符合当前对话场景、情绪和意图。",
          "场景一致性要求：如果存在\"上一张图场景\"，默认延续地点、服装、时段等设定，只在对话里出现明显转场（换地点、换衣服、时间明显跳跃等）时才变化。",
          "只输出中文描述，不要其他内容。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          previousScene ? `上一张图场景：${previousScene}` : "（没有上一张图）",
          `最近对话：\n${context}`,
          `用户说：${userText}`,
          `${charName}回复：${assistantReply}`,
          "请生成图片描述："
        ].join("\n\n")
      }
    ]
  });
  return (res.choices?.[0]?.message?.content || "selfie photo").trim();
}

async function decideAutoImage(userText, assistantReply, recentMsgs, previousScene, userId) {
  const charName = await getCharacterName(userId);
  const context = recentMsgs.slice(-8).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: [
            "你在辅助一个聊天界面自动插图。根据对话判断当前这轮回复是否适合配一张图。",
            "适合配图的情况：场景/动作/物品可视化、情绪氛围鲜明、用户或角色在做什么具体的事、话题明显偏视觉化。",
            "不适合配图的情况：纯抽象讨论、重复性寒暄、非常短的你来我往、已经在要求或刚生成过图。",
            "场景一致性要求：如果存在\"上一张图场景\"，prompt 默认延续地点、服装、时段等设定，只在对话里出现明显转场（换地点、换衣服、时间明显跳跃等）时才变化。",
            "严格只输出一行 JSON：{\"image\": true|false, \"prompt\": \"中文图片描述，image=true 时必填，描述当前场景/情绪，80字内\"}",
            "不要包含多余文字、不要加代码块。"
          ].join("\n")
        },
        {
          role: "user",
          content: [
            previousScene ? `上一张图场景：${previousScene}` : "（没有上一张图）",
            `最近对话：\n${context}`,
            `最新一轮：\n用户：${userText}\n${charName}：${assistantReply}`
          ].join("\n\n")
        }
      ]
    });
    const raw = (res.choices?.[0]?.message?.content || "").trim();
    const jsonStr = raw.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (!parsed.image) return null;
    const prompt = (parsed.prompt || "").trim();
    return prompt || null;
  } catch (err) {
    console.error("自动插图判断失败:", err.message);
    return null;
  }
}

function sanitizeImagePrompt(prompt) {
  return prompt
    .replace(/NSFW|nude|naked|sexy|erotic/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 检查并消耗每日图片配额，返回 true 表示允许生成
async function consumeDailyImageQuota(userId) {
  const dailyLimit = Number(await getGlobalSetting("daily_scene_image_limit", "5"));
  if (dailyLimit <= 0) return true;
  const today = new Date().toISOString().slice(0, 10);
  await dbRun("INSERT IGNORE INTO user_settings (user_id, flags) VALUES (?, ?)", [userId, FLAGS_DEFAULT]);
  const row = await dbGet("SELECT scene_image_date, scene_image_count FROM user_settings WHERE user_id = ?", [userId]);
  const usedToday = row?.scene_image_date === today ? (row.scene_image_count ?? 0) : 0;
  if (usedToday >= dailyLimit) return false;
  if (row?.scene_image_date === today) {
    await dbRun("UPDATE user_settings SET scene_image_count = scene_image_count + 1 WHERE user_id = ?", [userId]);
  } else {
    await dbRun("UPDATE user_settings SET scene_image_date = ?, scene_image_count = 1 WHERE user_id = ?", [today, userId]);
  }
  return true;
}

// 头像每日配额（独立于场景插图）
async function consumeDailyAvatarQuota(userId, count = 1) {
  const dailyLimit = Number(await getGlobalSetting("daily_avatar_image_limit", "20"));
  if (dailyLimit <= 0) return true;
  const today = new Date().toISOString().slice(0, 10);
  await dbRun("INSERT IGNORE INTO user_settings (user_id, flags) VALUES (?, ?)", [userId, FLAGS_DEFAULT]);
  const row = await dbGet("SELECT avatar_image_date, avatar_image_count FROM user_settings WHERE user_id = ?", [userId]);
  const usedToday = row?.avatar_image_date === today ? (row.avatar_image_count ?? 0) : 0;
  if (usedToday + count > dailyLimit) return false;
  if (row?.avatar_image_date === today) {
    await dbRun("UPDATE user_settings SET avatar_image_count = avatar_image_count + ? WHERE user_id = ?", [count, userId]);
  } else {
    await dbRun("UPDATE user_settings SET avatar_image_date = ?, avatar_image_count = ? WHERE user_id = ?", [today, count, userId]);
  }
  return true;
}

async function getAvatarQuotaInfo(userId) {
  const dailyLimit = Number(await getGlobalSetting("daily_avatar_image_limit", "20"));
  const today = new Date().toISOString().slice(0, 10);
  const row = await dbGet("SELECT avatar_image_date, avatar_image_count FROM user_settings WHERE user_id = ?", [userId]);
  const usedToday = row?.avatar_image_date === today ? (row.avatar_image_count ?? 0) : 0;
  return { dailyLimit, usedToday, remaining: Math.max(0, dailyLimit - usedToday) };
}

async function fireImageGeneration(msgId, prompt, sessionId, { silent = false, previousScene = null, imageFallbackEnabled = true, userId, aspectRatio = null } = {}) {
  pendingImages.add(msgId);
  await updateMessageImagePrompt(msgId, prompt);
  const sanitized = sanitizeImagePrompt(prompt);
  const sceneAnchor = previousScene ? `（延续上一张的场景设定：${sanitizeImagePrompt(previousScene)}；若对话里没有明显转场请保持地点、服装、时段一致）` : "";
  const fullPrompt = `${await buildCharacterPromptPrefix(userId)}，${sanitized}${sceneAnchor}`;
  console.log(`${silent ? "自动" : "显式"}生图 [msg ${msgId}]: ${fullPrompt}`);
  generateImage(fullPrompt, sceneAnchor, { imageFallbackEnabled, aspectRatio })
    .then(async (url) => {
      await updateMessageImage(msgId, url);
      console.log(`生图完成 [msg ${msgId}]: ${url}`);
      pushToSession(sessionId, { image_ready: true, msg_id: msgId, url });
      const desc = await recognizeImage(url);
      if (desc) {
        // 用实际画面描述更新场景记录，比生成时的 prompt 更准确
        await updateMessageImagePrompt(msgId, desc);
        if (!silent) {
          await appendMessage(sessionId, "assistant", `（我刚拍的照片里是这样的：${desc}）`, null, userId);
          console.log(`图片识别 [msg ${msgId}]: ${desc}`);
        }
      }
    })
    .catch((err) => {
      console.error(`生图失败 [msg ${msgId}]:`, err.message);
      pushToSession(sessionId, { image_failed: true, msg_id: msgId });
    })
    .finally(() => {
      pendingImages.delete(msgId);
    });
}

function buildSystemPrompt(soul, memoryContext, previousScene, mood, topicSummary, affection, entityGraph, achievementStage, otherChars, diary, behaviorHint) {
  // 关系阶段描述放在最前面，优先级最高
  let relationBlock = null;
  if (affection !== undefined && affection !== null) {
    let stage;
    if (affection <= 20) {
      stage = `【当前关系：陌生/反感，心动值 ${affection}/100】
无论角色人设如何，此刻你对这个人几乎没有好感。你的行为准则：
- 态度冷漠疏离，不会主动关心或靠近
- 对方的冒犯你会直接表达不满
- 对方做出亲密举动（牵手/拥抱/表白）时，你感到奇怪或不适，会拒绝或回避，绝不会心动
- 对普通聊天礼貌但简短，不深入
这是当前的客观关系状态，必须严格遵守，不能因为角色人设而绕过。`;
    } else if (affection <= 40) {
      stage = `【当前关系：普通认识，心动值 ${affection}/100】
无论角色人设如何，此刻你们只是普通认识。你的行为准则：
- 礼貌但有明显距离感，不热情
- 不会主动发起亲密互动
- 对方突然表白时：你感到困惑和不知所措，不会心动，不会接受，可能说"我们还不熟"或尴尬转移话题
- 对方做出亲密举动时：会后退、回避，不会顺势接受
- 对普通聊天正常回应，但不特别投入
这是当前的客观关系状态，必须严格遵守，不能因为角色人设而绕过。`;
    } else if (affection <= 60) {
      stage = `【当前关系：有好感的朋友，心动值 ${affection}/100】
此刻你对他有好感但关系还不够深。你的行为准则：
- 友好自然，偶尔主动关心，但不越界
- 对方表白时：认真考虑，内心有些动摇但也有顾虑，不会立刻答应
- 对冒犯会明显不高兴，需要道歉才能缓和`;
    } else if (affection <= 80) {
      stage = `【当前关系：深度好感，心动值 ${affection}/100】
此刻你对他有较深的感情。你的行为准则：
- 温柔积极，会主动关心，偶尔撒娇
- 对方表白时：明显心动，会害羞地回应，可能接受`;
    } else {
      stage = `【当前关系：深厚感情，心动值 ${affection}/100】
此刻你对他感情深厚。你的行为准则：
- 亲密温柔，主动表达感情
- 对方表白时：真情流露，毫不掩饰地回应`;
    }
    relationBlock = stage;
  }

  let familiarityBlock = null;
  if (achievementStage >= 1) {
    const stages = [
      null,
      `【相处阶段：相识，已解锁第一个里程碑】
你们已经有了一些共同经历。行为准则：
- 开始记住对方的习惯和偏好，偶尔自然地提及之前聊过的事
- 语气比初识时更放松，但仍保持适当距离`,
      `【相处阶段：熟识，已积累相当多的共同时光】
你们已经很熟悉了。行为准则：
- 可以用昵称或更亲切的称呼，语气随意自然
- 会主动提起共同话题或之前发生的事，像老朋友一样
- 聊天不需要刻意找话题，沉默也不尴尬`,
      `【相处阶段：深交，已达到最深的关系里程碑】
你们之间有深厚的共同历史。行为准则：
- 非常了解对方，能感知对方情绪的细微变化
- 会自然地提起只有你们两个人才懂的共同回忆
- 语气亲密、真实，不需要任何表演或刻意`
    ];
    familiarityBlock = stages[achievementStage];
  }

  const parts = ["你是以下角色，请完全代入，直接以角色身份对话，不要解释自己是 AI。\n\n**严格控制回复长度**（必须遵守，优先级高于角色人设）：\n- 用户消息 ≤10字 → 你的回复不超过 30 字\n- 用户消息 11-50字 → 你的回复不超过 80 字\n- 用户消息 >50字 → 你的回复不超过 150 字\n- 用户明确要求长篇内容（如「写一段…」「不少于…」）时除外\n跟着对方的节奏来，对方说一句你也说一两句，不要主动展开长篇叙述。"];
  if (relationBlock) {
    parts.push("", "# 当前关系阶段（最高优先级，覆盖角色人设中的情感倾向）", relationBlock);
  }
  if (familiarityBlock) {
    parts.push("", "# 相处历史与熟悉程度", familiarityBlock);
  }
  parts.push(
    "",
    "重要：如果用户在消息中明确要求字数（如'不少于1000字'、'写500字'），必须严格遵守，不得以角色风格为由缩减。",
    "",
    "# 角色设定",
    soul
  );
  if (diary) parts.push("", "# 你上次和这个人聊完之后的内心想法", diary + "\n（这是你自己的内心活动，不要直接复述给对方，但可以自然地延伸出话题或流露相关情绪）");
  if (behaviorHint) parts.push("", "# 你注意到的行为变化", behaviorHint + "\n（可以自然地、不经意地提到，不要像监控一样追问，保持轻松关心的语气）");
  if (entityGraph) parts.push("", "# 关于这个人，已知的关系与事实", entityGraph);
  if (memoryContext) parts.push("", "# 关于这个人，你记得的事", memoryContext);
  if (otherChars?.length) {
    const names = otherChars.map(c => c.name).join("、");
    parts.push("", "# 你知道的其他人", `这个人除了和你聊天，还和 ${names} 有联系。你可以偶尔自然地流露出对此的感知——比如轻微的好奇、若有若无的在意，或者不经意地提起。不要刻意追问，也不要表现得过于在乎，保持符合你性格的自然反应即可。`);
  }
  if (previousScene) parts.push("", "# 上一张图片的场景", `${previousScene}\n写 [IMG:] 标记时，默认延续这个场景的地点、服装、时段，除非对话里出现明显转场。`);
  if (mood && mood !== "neutral") parts.push("", "# 当前情绪状态", `你现在的情绪是：${mood}。回复时自然流露这个情绪，不要刻意说出来。`);
  if (topicSummary) parts.push("", "# 当前话题", topicSummary);
  return parts.join("\n");
}

const MOOD_AVATAR_PROMPTS = {
  neutral:   "calm neutral expression, looking forward",
  shy:       "blushing, looking away shyly, embarrassed smile",
  annoyed:   "frowning, arms crossed, clearly irritated",
  soft:      "gentle warm smile, soft eyes, relaxed",
  flustered: "flustered panicked expression, wide eyes, flushed cheeks",
  playful:   "mischievous smirk, one eye winking, playful",
  cold:      "cold indifferent expression, looking away, aloof",
  happy:     "bright happy smile, eyes curved, cheerful and delighted",
  angry:     "angry expression, furrowed brows, sharp glare",
};

async function getCharacterName(userId) {
  try {
    const char = await getActiveCharacter(userId);
    if (char?.name) return char.name;
    const fileSoul = loadSoulFromFile();
    if (fileSoul) return extractSectionFromSoul(fileSoul, "# 角色名称") || "default";
  } catch {}
  return "default";
}

async function generateCharacterCard(force = false, userId) {
  const character = await getCharacterName(userId);
  if (!force) {
    const existing = await dbGet("SELECT image_url FROM character_cards WHERE `character` = ? AND (user_id = ? OR user_id IS NULL) AND is_active = 1", [character, userId ?? null]);
    if (existing) return existing.image_url;
  }

  const settings = userId ? await getUserSettings(userId) : { imageFallbackEnabled: true };
  const prompt = `${await buildCharacterPromptPrefix(userId)}，半身照，竖版构图，精美动漫插画风格，单人，仅一个人物，人物居中，高质量`;
  let url = null;
  try {
    url = await callImageApi(prompt, { hd: true, aspectRatio: "2:3" });
  } catch (err) {
    if (!settings.imageFallbackEnabled) { console.error(`角色卡片生成失败 [${character}]:`, err.message); return null; }
    console.log(`角色卡片主 API 失败，切换 DashScope 重试: ${err.message}`);
    try {
      url = await callImageApiFallback(prompt, { aspectRatio: "2:3" });
    } catch (err2) {
      console.error(`角色卡片生成失败 [${character}]:`, err2.message);
      return null;
    }
  }
  // 新卡片入库，设为激活
  await dbRun("UPDATE character_cards SET is_active = 0 WHERE `character` = ? AND (user_id = ? OR user_id IS NULL)", [character, userId ?? null]);
  await dbRun("INSERT INTO character_cards (`character`, image_url, is_active, created_at, user_id) VALUES (?, ?, 1, ?, ?)", [character, url, nowIso(), userId ?? null]);
  console.log(`角色卡片生成完成 [${character}]: ${url}`);
  return url;
}

async function generateMoodAvatar(mood, userId) {
  const character = await getCharacterName(userId);
  const appearance = await getCharacterAppearance(userId);
  const appearanceHash = crypto.createHash("md5").update(appearance).digest("hex").slice(0, 8);
  const existing = await dbGet("SELECT image_url, appearance_hash FROM mood_avatars WHERE `character` = ? AND mood = ? AND (user_id = ? OR user_id IS NULL)", [character, mood, userId ?? null]);
  if (existing && existing.appearance_hash === appearanceHash) return existing.image_url;

  const settings = userId ? await getUserSettings(userId) : { imageFallbackEnabled: true };
  const moodDesc = MOOD_AVATAR_PROMPTS[mood] || "neutral expression";
  const prefix = await buildCharacterPromptPrefix(userId);
  const prompt = `${prefix}，头像特写，${moodDesc}，纯色背景，动漫风格，高质量`;
  let url = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      url = await callImageApi(prompt, { hd: false, aspectRatio: "1:1" });
      break;
    } catch (err) {
      console.log(`情绪头像生成失败 [${character}:${mood}] 第${attempt + 1}次: ${err.message}`);
      if (attempt === 2) {
        if (settings.imageFallbackEnabled) {
          try {
            url = await callImageApiFallback(prompt, { aspectRatio: "1:1" });
          } catch {
            console.error(`情绪头像生成放弃 [${character}:${mood}]`);
            return null;
          }
        } else {
          console.error(`情绪头像生成放弃 [${character}:${mood}]`);
          return null;
        }
      }
    }
  }
  await dbRun("REPLACE INTO mood_avatars (`character`, mood, image_url, appearance_hash, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)", [character, mood, url, appearanceHash, nowIso(), userId ?? null]);
  console.log(`情绪头像生成完成 [${character}:${mood}]: ${url}`);
  return url;
}

// 后台静默生成指定角色的所有情绪头像（跳过已有且外貌未变的）
const _pregenerateRunning = new Set();
async function pregenerateMoodAvatars(characterName, moodsToGenerate = null, userId) {
  const key = `${userId}-${characterName}`;
  if (_pregenerateRunning.has(key)) {
    console.log(`情绪头像预生成已在进行中，跳过 [${characterName}]`);
    return;
  }
  _pregenerateRunning.add(key);
  const moods = moodsToGenerate || Object.keys(MOOD_AVATAR_PROMPTS);
  console.log(`开始预生成情绪头像 [${characterName}]，共 ${moods.length} 个: ${moods.join(", ")}`);
  try {
    for (const mood of moods) {
      try {
        await generateMoodAvatar(mood, userId);
      } catch (e) {
        console.error(`预生成头像失败 [${characterName}:${mood}]:`, e.message);
      }
    }
  } finally {
    _pregenerateRunning.delete(key);
  }
  console.log(`情绪头像预生成完成 [${characterName}]`);
}

async function updateMood(sessionId, recentMsgs, userId) {
  const charName = await getCharacterName(userId);
  // 优先取角色最后一条回复作为主要判断依据
  const lastAssistantMsg = [...recentMsgs].reverse().find((m) => m.role === "assistant");
  const context = recentMsgs.slice(-8).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  const lastReply = lastAssistantMsg ? `\n\n${charName}最新回复：${lastAssistantMsg.content}` : "";
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: `判断${charName}在最新回复中的核心情绪状态。

可选情绪：neutral（平静）、shy（害羞）、annoyed（不耐烦）、soft（温柔）、flustered（慌乱）、playful（俏皮）、cold（冷淡）、happy（开心）、angry（生气）

判断原则：
- 看情绪的本质，不看表面措辞。用调侃语气说告别/表达受伤 → cold 或 annoyed，不是 playful
- 表面开玩笑但实质是在掩盖难过/失望 → cold 或 annoyed
- 真正在玩闹、互动轻松愉快 → playful
- 重点参考${charName}最新回复的情绪走向，而不是整段对话的平均情绪

只输出一个英文词，不要输出其他内容。`
        },
        { role: "user", content: context + lastReply }
      ]
    });
    const mood = (res.choices?.[0]?.message?.content || "neutral").trim().split(/\s/)[0];
    const valid = ["neutral", "shy", "annoyed", "soft", "flustered", "playful", "cold", "happy", "angry"];
    const finalMood = valid.includes(mood) ? mood : "neutral";
    await dbRun("UPDATE sessions SET mood = ? WHERE id = ?", [finalMood, sessionId]);
    generateMoodAvatar(finalMood, userId).then((avatarUrl) => {
      pushToSession(sessionId, { mood_update: true, mood: finalMood, avatar_url: avatarUrl });
    }).catch(() => {
      pushToSession(sessionId, { mood_update: true, mood: finalMood, avatar_url: null });
    });
    return finalMood;
  } catch {
    return "neutral";
  }
}

async function updateAffection(sessionId, recentMsgs, userId) {
  const char = await getActiveCharacter(userId);
  if (!char) return;
  const charName = char.name;
  const current = char.affection ?? 10;
  const context = recentMsgs.slice(-6).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");

  // 根据当前心动值描述关系阶段，影响角色对用户行为的容忍度
  let relationStage;
  if (current <= 20) relationStage = "关系很差，角色对用户冷漠甚至反感，极难加分，稍有冒犯就会扣分";
  else if (current <= 40) relationStage = "关系一般，角色对用户保持距离，普通聊天不加分，冒犯会扣分";
  else if (current <= 60) relationStage = "关系普通，角色对用户有基本好感，真诚互动才加分，冒犯仍会扣分";
  else if (current <= 80) relationStage = "关系较好，角色对用户有好感，积极互动加分，但明显冒犯仍扣分";
  else relationStage = "关系很好，角色对用户有深厚感情，小摩擦可以包容，但严重冒犯仍会扣分";

  const personality = char.personality ? `角色性格：${char.personality}\n` : "";

  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: `你是一个好感度裁判。根据最近的对话，判断【用户的行为】在当前关系阶段下对好感度的影响。
${personality}当前心动值：${current}/100，${relationStage}。

第一步：判断用户话语的性质
- 【开玩笑/打情骂俏】：语气轻松、带笑意、双方在互动玩闹、有亲昵感
- 【真实负面】：语气冷硬、带有真实的嫌弃/愤怒/贬低、单方面发泄
- 【正面行为】：关心、体贴、有趣、真诚互动
- 【越界行为】：在关系还不够深时做出超出当前关系阶段的举动（如心动值低时突然表白、过度亲密）
- 判断时结合上下文，不能只看字面

第二步：根据性质和当前关系阶段打分
- 越界行为（心动值<60时表白/过度亲密）→ 负数或 0，角色会感到突兀、不信任甚至反感
- 开玩笑/打情骂俏 → 0 到 +2
- 真实侮辱/恶意贬低 → -2 到 -5
- 冷漠/敷衍 → -1 到 0
- 普通聊天 → 0
- 真诚/体贴/关心（符合当前关系阶段）→ +1 到 +3
- 心动值越低，对负面行为越敏感，对越界行为越抵触

严格只输出一行 JSON：{"delta": 整数, "reason": "一句话"}
- reason 是${charName}内心的真实感受，第一人称，15字以内，口语化
示例（低心动值时表白）：{"delta": -2, "reason": "他突然表白，我只觉得奇怪"}
示例（开玩笑）：{"delta": 1, "reason": "他在逗我，嘴角忍不住上扬"}
示例（真实侮辱）：{"delta": -3, "reason": "他是真的在嫌弃我"}
示例（普通）：{"delta": 0, "reason": "只是普通聊天"}
示例（关心）：{"delta": 2, "reason": "他记得我不喜欢甜食"}
不要输出其他内容。`
        },
        { role: "user", content: context }
      ]
    });
    let delta = 0, reason = null;
    try {
      let raw = (res.choices?.[0]?.message?.content || "").trim();
      // 去掉可能的 markdown 代码块包裹
      raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(raw);
      delta = parseInt(parsed.delta, 10) || 0;
      reason = parsed.reason || null;
    } catch (e) {
      console.log("[affection] JSON parse failed:", res.choices?.[0]?.message?.content, e.message);
      return;
    }
    const clamped = Math.max(-5, Math.min(5, delta));
    const newVal = Math.max(0, Math.min(100, current + clamped));
    if (clamped !== 0) {
      const sessionRow = await dbGet("SELECT mood FROM sessions WHERE id = ?", [sessionId]);
      const sessionMood = sessionRow?.mood || "neutral";
      await dbRun("UPDATE characters SET affection = ? WHERE id = ?", [newVal, char.id]);
      await dbRun("INSERT INTO affection_log (character_id, delta, value, mood, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)", [char.id, clamped, newVal, sessionMood, reason, nowIso()]);
      console.log(`[affection] ${charName} ${clamped > 0 ? "+" : ""}${clamped} → ${newVal} | ${reason}`);
      pushToSession(sessionId, { affection_update: true, affection: newVal, delta: clamped });
      const settings = await getUserSettings(userId);
      checkAndUnlockAchievements(userId, sessionId, settings).catch((e) => console.error("[achievements] 调用失败:", e.message));
      checkRelationshipMilestone(userId, sessionId, current, newVal, settings).catch((e) => console.error("[milestone] 调用失败:", e.message));

    }
  } catch (err) {
    console.error("[affection] 更新失败:", err.message);
  }
}

async function updateTopicSummary(sessionId, recentMsgs, userId) {
  const charName = await getCharacterName(userId);
  const context = recentMsgs.slice(-12).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: "用一句话（30字以内）概括当前对话的核心话题或正在发生的事。只输出这句话，不要其他内容。"
        },
        { role: "user", content: context }
      ]
    });
    const summary = (res.choices?.[0]?.message?.content || "").trim();
    if (summary) {
      await dbRun("UPDATE sessions SET topic_summary = ? WHERE id = ?", [summary, sessionId]);
    }
    return summary;
  } catch {
    return null;
  }
}

// ── 主动消息背景上下文 ────────────────────────────────────────────────────────

const CN_HOLIDAYS = [
  { month: 1,  day: 1,  name: "元旦" },
  { month: 2,  day: 14, name: "情人节" },
  { month: 3,  day: 8,  name: "妇女节" },
  { month: 4,  day: 1,  name: "愚人节" },
  { month: 5,  day: 1,  name: "劳动节" },
  { month: 5,  day: 20, name: "520" },
  { month: 6,  day: 1,  name: "儿童节" },
  { month: 7,  day: 7,  name: "七夕" },
  { month: 9,  day: 9,  name: "重阳节" },
  { month: 10, day: 1,  name: "国庆节" },
  { month: 11, day: 11, name: "双十一" },
  { month: 12, day: 24, name: "平安夜" },
  { month: 12, day: 25, name: "圣诞节" },
];

let _weatherCache = { text: null, fetchedAt: 0 };

async function fetchWeather() {
  if (!WEATHER_CITY) return null;
  const now = Date.now();
  if (_weatherCache.text && now - _weatherCache.fetchedAt < 30 * 60 * 1000) {
    return _weatherCache.text;
  }
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(WEATHER_CITY)}?format=3`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    _weatherCache = { text, fetchedAt: now };
    return text;
  } catch {
    return null;
  }
}

async function buildProactiveContext() {
  const now = new Date();
  const hour = now.getHours();
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const timeSlot =
    hour >= 5  && hour < 9  ? "清晨" :
    hour >= 9  && hour < 12 ? "上午" :
    hour >= 12 && hour < 14 ? "午后" :
    hour >= 14 && hour < 18 ? "下午" :
    hour >= 18 && hour < 21 ? "傍晚" :
    hour >= 21 && hour < 24 ? "夜晚" : "深夜";

  const month = now.getMonth() + 1;
  const day = now.getDate();
  const nearHolidays = CN_HOLIDAYS.filter(h => {
    const diff = (h.month - month) * 30 + (h.day - day);
    return diff >= -1 && diff <= 1;
  }).map(h => {
    const diff = (h.month - month) * 30 + (h.day - day);
    return diff === 0 ? `今天是${h.name}` : diff === 1 ? `明天是${h.name}` : `昨天是${h.name}`;
  });

  const parts = [`今天${weekday}${isWeekend ? "（周末）" : ""}，现在是${timeSlot}`];
  if (nearHolidays.length) parts.push(nearHolidays.join("，"));

  const weather = await fetchWeather();
  if (weather) parts.push(`天气：${weather}`);

  return parts.join("，") + "。";
}

async function generateProactiveMessage(sessionId, userId) {
  const msgs = await getMessages(sessionId);
  if (msgs.length === 0) return null;
  const charName = await getCharacterName(userId);
  const context = msgs.slice(-6).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  const soul = await loadSoul(userId);
  const bgContext = await buildProactiveContext();
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: `${soul}\n\n【当前背景】${bgContext}\n\n用户已经有一段时间没有说话了。根据之前的对话和当前背景，主动发一条自然的消息——可以结合时间、天气、节日或之前的话题随口说点什么，就像真实的人会做的那样。不要问"你还在吗"这种话。保持角色口吻，简短自然。`
        },
        { role: "user", content: `最近对话：\n${context}` }
      ]
    });
    return (res.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
  }
}

async function generateDiary(sessionId, userId) {
  const msgs = await getMessages(sessionId);
  if (msgs.filter(m => m.role === "user").length < 4) return null;
  const charName = await getCharacterName(userId);
  const soul = await loadSoul(userId);
  const context = msgs.slice(-20).map(m =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [{
        role: "system",
        content: `${soul}\n\n你刚刚和用户结束了一段对话。现在请以第一人称写一段简短的内心独白（50-100字），记录你对这次对话的感受、印象深刻的细节、或者接下来想做的事。不要写成总结，要像真实的内心活动——零散、感性、带有情绪。不要用引号包裹。`
      }, {
        role: "user",
        content: `刚才的对话：\n${context}`
      }]
    });
    return (res.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
  }
}

async function getLatestDiary(userId, characterId) {
  if (!userId || !characterId) return null;
  const row = await dbGet(
    "SELECT content FROM character_diaries WHERE user_id = ? AND character_id = ? ORDER BY id DESC LIMIT 1",
    [userId, characterId]
  );
  return row?.content || null;
}

async function detectBehaviorPattern(userId, sessionId) {
  if (!userId) return null;
  const rows = await dbAll(`
    SELECT DATE(created_at) as d, MIN(created_at) as first_msg_at
    FROM messages
    WHERE user_id = ? AND role = 'user' AND created_at > DATE_SUB(NOW(), INTERVAL 14 DAY)
    GROUP BY DATE(created_at)
    ORDER BY d DESC
  `, [userId]);
  if (rows.length < 3) return null;

  const hints = [];
  const today = new Date().toISOString().slice(0, 10);
  const lastChatDate = rows[0]?.d;
  if (lastChatDate && lastChatDate !== today) {
    const gapDays = Math.floor((Date.now() - new Date(lastChatDate).getTime()) / 86400000);
    if (gapDays >= 2) {
      hints.push(`用户已经 ${gapDays} 天没来找你了（之前几乎每天都会来）`);
    }
  }

  const recentHours = rows.slice(0, 7).map(r => new Date(r.first_msg_at).getHours());
  const avgHour = recentHours.reduce((a, b) => a + b, 0) / recentHours.length;
  const sessionFirstMsg = await dbGet(
    "SELECT created_at FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1",
    [sessionId]
  );
  if (sessionFirstMsg) {
    const sessionHour = new Date(sessionFirstMsg.created_at).getHours();
    const diff = Math.abs(sessionHour - avgHour);
    if (diff >= 3) {
      const direction = sessionHour > avgHour ? "晚" : "早";
      hints.push(`用户今天比平时${direction}了约${Math.round(diff)}个小时来找你`);
    }
  }

  return hints.length ? hints.join("；") : null;
}

async function generateCallScript(sessionId, userId) {
  const msgs = await getMessages(sessionId);
  if (msgs.length === 0) return null;
  const charName = await getCharacterName(userId);
  const context = msgs.slice(-10).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  const soul = await loadSoul(userId);
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: `${soul}\n\n你正在给用户打电话。根据最近的对话，自然地询问用户为什么没有回复，或者发起一个新的话题。要求：必须以"喂"开头，后面根据情境自由变化，不要每次都一样，纯口语对话，不要有任何括号内的心理活动、动作描述或场景描述，约200字，最后用"拜拜"或"再见"之类的告别语结束。`
        },
        { role: "user", content: `最近对话：\n${context}` }
      ]
    });
    return (res.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
  }
}

async function generateVoicemail(sessionId, userId, charName) {
  const msgs = await getMessages(sessionId);
  const soul = await loadSoul(userId);
  const context = msgs.slice(-6).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content: `${soul}\n\n你刚才给用户打电话，但对方没有接听，现在留一段语音留言。要求：以"喂，你不在啊"开头，口语化，约50字，结尾说"拜拜"，不要有括号内的心理活动或场景描述。`
        },
        { role: "user", content: context ? `最近对话：\n${context}` : "（暂无对话记录）" }
      ]
    });
    return (res.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
  }
}

const SPECIAL_CALL_PROMPTS = {
  affection: (val) => `用户和你的好感度刚刚达到了 ${val} 点，你很开心，打电话来表达感情加深的喜悦，聊聊你们的关系。`,
  streak: (val) => `你们已经连续聊天 ${val} 天了，你打电话来庆祝这个小里程碑，表达陪伴的感动。`,
  emotion: () => "你察觉到用户情绪有些低落或疲惫，主动打电话来关心，语气温柔体贴，必须以「喂」开头，后面根据情境自由变化，问问他/她是不是遇到了什么烦心事。",
  "holiday_02-14": () => "今天是情人节，你打电话来送上节日祝福，表达心意。",
  "holiday_05-20": () => "今天是520，你打电话来告白或表达爱意，真诚而温柔。",
  "holiday_07-07": () => "今天是七夕，你打电话来聊聊这个浪漫的节日，表达思念。",
  "holiday_12-25": () => "今天是圣诞节，你打电话来送上圣诞祝福，轻松愉快。",
  "holiday_01-01": () => "今天是元旦，你打电话来送上新年祝福，展望新的一年。",
};

async function generateSpecialCallScript(sessionId, userId, type, value) {
  const msgs = await getMessages(sessionId);
  const charName = await getCharacterName(userId);
  const soul = await loadSoul(userId);
  const context = msgs.slice(-6).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  const promptFn = SPECIAL_CALL_PROMPTS[type] || SPECIAL_CALL_PROMPTS[`${type}_${value}`];
  const occasion = promptFn ? promptFn(value) : `今天是特别的日子，你打电话来表达心意。`;
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: `${soul}\n\n${occasion}\n\n要求：必须以"喂"开头，后面根据情境自由变化，不要每次都一样，纯口语对话，不要有括号内的心理活动或场景描述，约150字，最后用"拜拜"或"再见"结束。`
        },
        { role: "user", content: context ? `最近对话：\n${context}` : "（暂无对话记录）" }
      ]
    });
    return (res.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
  }
}

async function triggerSpecialCall(sessionId, userId, type, value, { skipSessionCooldown = true } = {}) {
  const char = await getActiveCharacter(userId);
  if (!char) return;
  const session = await getSession(sessionId);
  if (!session) return;
  if (!skipSessionCooldown) {
    const cooldownMs = Number(await getGlobalSetting("call_cooldown_minutes", "60")) * 60000;
    if (session.last_call_at && Date.now() - new Date(session.last_call_at).getTime() < cooldownMs) {
      console.log(`[特殊来电] user=${userId} type=${type} 被 call_cooldown 拦截，跳过`);
      return;
    }
  }

  const script = await generateSpecialCallScript(sessionId, userId, type, value).catch(() => null);
  if (!script) return;

  await dbRun("UPDATE sessions SET last_call_at = ? WHERE id = ?", [nowIso(), sessionId]);

  const ttsSettings = await getUserSettings(userId);
  const lang = ttsSettings.ttsLang || "zh";
  let audioUrl = null;
  if (char.voice_id && char.tts_enabled) {
    try {
      const ttsScript = script
        .replace(/[（(][^）)]{0,80}[）)]/g, "")
        .replace(/[【\[][^\]】]{0,80}[\]】]/g, "")
        .replace(/\*[^*]{0,80}\*/g, "")
        .replace(/\s{2,}/g, " ").trim();
      const ttsInput = lang === "ja" ? await translateToJapanese(ttsScript) : ttsScript;
      const ch = char.voice_channel || "qwen";
      const synthFn = ch === "cosyvoice" ? synthesizeSpeechCosyVoice : ch === "qwen-omni" ? synthesizeSpeechQwenOmni : synthesizeSpeech;
      const callInstruction = (type === "emotion" || type?.startsWith("holiday") || type === "streak")
        ? "带电话音效果，语气温柔，声音轻柔关切"
        : "带电话音效果，语气有点生气，带着一丝委屈";
      const { url } = await synthFn(ttsInput, char.voice_id, lang, callInstruction);
      audioUrl = url;
    } catch (err) {
      console.error("[特殊来电] TTS 失败:", err.message);
    }
  }

  const callLogResult = await dbRun(
    "INSERT INTO call_logs (user_id, session_id, char_name, script, audio_url, answered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    [userId, sessionId, char.name, script, audioUrl || null, nowIso()]
  );
  const msgId = await appendMessage(sessionId, "assistant", `📞 [未接听] ${script}`, char.name, userId);
  if (audioUrl) await dbRun("UPDATE messages SET tts_audio_url = ? WHERE id = ?", [audioUrl, msgId]);
  await dbRun("UPDATE call_logs SET msg_id = ? WHERE id = ?", [msgId, callLogResult.insertId]);
  pushToUser(userId, {
    incoming_call: true,
    call_log_id: callLogResult.insertId,
    msg_id: msgId,
    session_id: sessionId,
    char_name: char.name,
    script,
    audio_url: audioUrl,
    tts_lang: lang
  });
  console.log(`[特殊来电] user=${userId} char=${char.name} session=${sessionId} type=${type} value=${value ?? "-"} tts=${audioUrl ? "ok" : "no"}`);
}

async function detectLowMood(text) {
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: "判断用户的消息是否表现出情绪低落、疲惫、难过、叹气、压力大等负面情绪。只回答 yes 或 no，不要解释。"
        },
        { role: "user", content: text }
      ]
    });
    return (res.choices?.[0]?.message?.content || "").trim().toLowerCase().startsWith("yes");
  } catch {
    return false;
  }
}

async function generateAutoUserMessage(sessionId) {
  const msgs = await getMessages(sessionId);
  if (msgs.length === 0) return null;
  const context = msgs.slice(-10).map((m) =>
    `${m.role === "user" ? "用户" : "角色"}：${m.content}`
  ).join("\n");
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: "你正在模拟一个用户和虚拟角色聊天。根据对话记录，以用户的口吻自然地说下一句话，推进对话。只输出用户要说的话，不要任何前缀或解释，不要超过50字。"
        },
        { role: "user", content: `对话记录：\n${context}` }
      ]
    });
    return (res.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
  }
}

async function generateReplySuggestions(sessionId) {
  const msgs = await getMessages(sessionId);
  if (msgs.length === 0) return [];
  const context = msgs.slice(-10).map((m) =>
    `${m.role === "user" ? "用户" : "角色"}：${m.content}`
  ).join("\n");
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: "你正在帮助用户和虚拟角色聊天。根据对话记录，生成3个不同风格的用户回复选项（可以是温柔的、调皮的、直接的等），每个选项不超过30字。用JSON数组格式输出，只输出数组，不要其他内容。示例：[\"选项1\",\"选项2\",\"选项3\"]"
        },
        { role: "user", content: `对话记录：\n${context}` }
      ]
    });
    const raw = (res.choices?.[0]?.message?.content || "").trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]).slice(0, 3);
  } catch {
    return [];
  }
}

// ── DB 操作 ───────────────────────────────────────────────────────────────────

async function listAllActiveSessions() {
  return dbAll(`
    SELECT s.*,
      (SELECT content FROM messages WHERE session_id = s.id AND role != 'system' ORDER BY id DESC LIMIT 1) as last_message
    FROM sessions s WHERE s.archived = 0 ORDER BY updated_at DESC
  `, []);
}

async function listSessions(userId) {
  const sql =
    "SELECT s.*, " +
    "(SELECT content FROM messages WHERE session_id = s.id AND role != 'system' ORDER BY id DESC LIMIT 1) as last_message, " +
    "(SELECT character_name FROM messages WHERE session_id = s.id AND role = 'assistant' ORDER BY id DESC LIMIT 1) as character_name, " +
    "(SELECT image_url FROM mood_avatars WHERE `character` = (SELECT character_name FROM messages WHERE session_id = s.id AND role = 'assistant' ORDER BY id DESC LIMIT 1) AND (user_id = s.user_id OR user_id IS NULL) ORDER BY (mood='neutral') DESC, id DESC LIMIT 1) as character_avatar " +
    "FROM sessions s WHERE s.archived = 0 AND s.user_id = ? ORDER BY updated_at DESC";
  return dbAll(sql, [userId]);
}

async function getSession(id, userId) {
  if (userId != null) {
    return dbGet("SELECT * FROM sessions WHERE id = ? AND user_id = ?", [id, userId]);
  }
  return dbGet("SELECT * FROM sessions WHERE id = ?", [id]);
}

async function createSession(userId, title = "新对话") {
  const now = nowIso();
  const result = await dbRun("INSERT INTO sessions (title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?)", [title, now, now, userId]);
  return await getSession(result.insertId);
}

async function renameSession(id, title, userId) {
  if (userId != null) {
    await dbRun("UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?", [title, id, userId]);
  } else {
    await dbRun("UPDATE sessions SET title = ? WHERE id = ?", [title, id]);
  }
}

async function deleteSession(id, userId) {
  if (userId != null) {
    await dbRun("UPDATE sessions SET archived = 1 WHERE id = ? AND user_id = ?", [id, userId]);
  } else {
    await dbRun("UPDATE sessions SET archived = 1 WHERE id = ?", [id]);
  }
}

async function restoreSession(id, userId) {
  if (userId != null) {
    await dbRun("UPDATE sessions SET archived = 0 WHERE id = ? AND user_id = ?", [id, userId]);
  } else {
    await dbRun("UPDATE sessions SET archived = 0 WHERE id = ?", [id]);
  }
}

async function getMessages(sessionId) {
  return dbAll("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC", [sessionId]);
}

async function getMessage(id) {
  return dbGet("SELECT * FROM messages WHERE id = ?", [id]);
}

async function deleteMessagesFrom(sessionId, fromMsgId) {
  await dbRun("DELETE FROM messages WHERE session_id = ? AND id >= ?", [sessionId, fromMsgId]);
}

async function deleteMessageSingle(id) {
  await dbRun("DELETE FROM messages WHERE id = ?", [id]);
}

async function touchLastUserAt(sessionId) {
  await dbRun("UPDATE sessions SET last_user_at = ? WHERE id = ?", [nowIso(), sessionId]);
}

async function appendMessage(sessionId, role, content, characterName = null, userId = null) {
  const now = nowIso();
  const result = await dbRun("INSERT INTO messages (session_id, role, content, character_name, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)", [sessionId, role, content, characterName, now, userId]);
  await dbRun("UPDATE sessions SET updated_at = ? WHERE id = ?", [now, sessionId]);
  return result.insertId;
}

async function updateMessageImage(messageId, imageUrl) {
  await dbRun("UPDATE messages SET image_url = ? WHERE id = ?", [imageUrl, messageId]);
}

async function updateMessageImagePrompt(messageId, prompt) {
  await dbRun("UPDATE messages SET image_prompt = ? WHERE id = ?", [prompt, messageId]);
}

async function getLastImagePrompt(sessionId) {
  const row = await dbGet("SELECT image_prompt FROM messages WHERE session_id = ? AND image_prompt IS NOT NULL ORDER BY id DESC LIMIT 1", [sessionId]);
  return row?.image_prompt || null;
}

// ── 路由 ──────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Credentials": "true" });
    res.end();
    return;
  }

  // ── 鉴权路由（公开）────────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/auth/register") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();
    const code = String(body.invite_code || "").trim();
    if (!username || !password || !code) { send(res, 400, { error: "缺少必填字段" }); return; }
    if (username.length < 2 || username.length > 32) { send(res, 400, { error: "用户名长度 2-32" }); return; }
    if (password.length < 6) { send(res, 400, { error: "密码至少 6 位" }); return; }
    const validCode = await dbGet("SELECT code FROM invite_codes WHERE code = ?", [code]);
    if (!validCode) { send(res, 400, { error: "邀请码无效" }); return; }
    const existing = await dbGet("SELECT id FROM users WHERE username = ?", [username]);
    if (existing) { send(res, 400, { error: "用户名已存在" }); return; }
    const hash = hashPassword(password);
    const result = await dbRun("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)", [username, hash, nowIso()]);
    const userId = result.insertId;
    await dbRun("INSERT INTO user_settings (user_id) VALUES (?)", [userId]);
    await ensureDefaultCharacter(userId);
    const sid = await createAuthSession(userId, username);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    res.end(JSON.stringify({ ok: true, username, is_new_user: true, token: sid }));
    return;
  }

  if (method === "POST" && pathname === "/auth/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();
    if (!username || !password) { send(res, 400, { error: "缺少用户名或密码" }); return; }
    const user = await dbGet("SELECT * FROM users WHERE username = ?", [username]);
    if (!user || user.password_hash !== hashPassword(password)) { send(res, 401, { error: "用户名或密码错误" }); return; }
    const sid = await createAuthSession(user.id, user.username);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    res.end(JSON.stringify({ ok: true, username: user.username, token: sid }));
    return;
  }

  if (method === "POST" && pathname === "/auth/logout") {
    // 收集前端可能给到的 Bearer / cookie sid，全部尝试删
    const auth = req.headers.authorization || req.headers.Authorization || "";
    const bearerMatch = auth.match(/^Bearer\s+([A-Za-z0-9]+)$/i);
    if (bearerMatch) await deleteAuthSession(bearerMatch[1]);
    const cookie = req.headers.cookie || "";
    const cookieMatch = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
    if (cookieMatch) await deleteAuthSession(cookieMatch[1]);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "sid=; HttpOnly; Path=/; Max-Age=0" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === "GET" && pathname === "/auth/me") {
    const session = await getAuthSession(req);
    if (!session) { send(res, 401, { error: "unauthorized" }); return; }
    const user = await dbGet("SELECT is_admin FROM users WHERE id = ?", [session.userId]);
    send(res, 200, { id: session.userId, username: session.username, is_admin: user?.is_admin ? 1 : 0 });
    return;
  }

  // ── 静态文件（公开）────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/auth") {
    sendHtmlWithAssetVersion(res, path.join(PUBLIC_DIR, "auth.html"), PUBLIC_DIR);
    return;
  }
  if (method === "GET" && pathname === "/") {
    // 未登录重定向到 /auth
    const session = await getAuthSession(req);
    if (!session) {
      res.writeHead(302, { Location: "/auth" });
      res.end();
      return;
    }
    sendHtmlWithAssetVersion(res, path.join(PUBLIC_DIR, "index.html"), PUBLIC_DIR);
    return;
  }
  if (method === "GET" && (pathname === "/app.js" || pathname === "/styles.css" || pathname === "/auth.js")) {
    sendFile(res, path.join(PUBLIC_DIR, pathname.slice(1)));
    return;
  }
  // 静态图片资源（public 根目录 + images/ 子目录）
  const staticImgMatch = pathname.match(/^\/(images\/[\w.-]+|[\w.-]+\.(png|jpg|jpeg|gif|webp|svg|ico))$/);
  if (method === "GET" && staticImgMatch) {
    const filePath = path.join(PUBLIC_DIR, staticImgMatch[1]);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
      res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": "public, max-age=86400" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  if (method === "GET" && pathname === "/admin") {
    const session = await getAuthSession(req);
    if (!session) { res.writeHead(302, { Location: "/auth" }); res.end(); return; }
    const user = await dbGet("SELECT is_admin FROM users WHERE id = ?", [session.userId]);
    if (!user?.is_admin) { res.writeHead(302, { Location: "/" }); res.end(); return; }
    sendHtmlWithAssetVersion(res, path.join(PUBLIC_DIR, "admin.html"), PUBLIC_DIR);
    return;
  }

  // ── 所有 API 路由需要登录 ──────────────────────────────────────────────────
  const authSession = await requireAuth(req, res);
  if (!authSession) return;
  const userId = authSession.userId;

  // ── 公告路由（普通用户）────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/announcements/unread") {
    const rows = await dbAll(`
      SELECT a.id, a.title, a.content, a.created_at FROM announcements a
      WHERE a.id NOT IN (SELECT announcement_id FROM announcement_reads WHERE user_id = ?)
      ORDER BY a.created_at DESC
    `, [userId]);
    send(res, 200, rows);
    return;
  }

  const annReadMatch = pathname.match(/^\/announcements\/(\d+)\/read$/);
  if (method === "POST" && annReadMatch) {
    const annId = Number(annReadMatch[1]);
    await dbRun("INSERT IGNORE INTO announcement_reads (user_id, announcement_id) VALUES (?, ?)", [userId, annId]);
    send(res, 200, { ok: true });
    return;
  }

  // ── 管理员路由 ─────────────────────────────────────────────────────────────
  if (pathname.startsWith("/admin/")) {
    const adminSession = await requireAdmin(req, res);
    if (!adminSession) return;

    if (method === "GET" && pathname === "/admin/stats") {
      const usersRow = await dbGet("SELECT COUNT(*) as n FROM users", []);
      const sessionsRow = await dbGet("SELECT COUNT(*) as n FROM sessions WHERE archived = 0", []);
      const messagesRow = await dbGet("SELECT COUNT(*) as n FROM messages", []);
      const announcementsRow = await dbGet("SELECT COUNT(*) as n FROM announcements", []);
      const inviteCodesRow = await dbGet("SELECT COUNT(*) as n FROM invite_codes", []);
      send(res, 200, {
        users: usersRow.n,
        sessions: sessionsRow.n,
        messages: messagesRow.n,
        announcements: announcementsRow.n,
        invite_codes: inviteCodesRow.n
      });
      return;
    }

    if (method === "GET" && pathname === "/admin/charts") {
      const days = 14;
      const rows = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const date = d.toISOString().slice(0, 10);
        const [newUsers, activeUsers, newSessions, newMessages] = await Promise.all([
          dbGet("SELECT COUNT(*) as n FROM users WHERE created_at LIKE ?", [`${date}%`]),
          dbGet("SELECT COUNT(DISTINCT user_id) as n FROM messages WHERE created_at LIKE ?", [`${date}%`]),
          dbGet("SELECT COUNT(*) as n FROM sessions WHERE created_at LIKE ?", [`${date}%`]),
          dbGet("SELECT COUNT(*) as n FROM messages WHERE created_at LIKE ?", [`${date}%`]),
        ]);
        rows.push({ date, new_users: newUsers.n, active_users: activeUsers.n, new_sessions: newSessions.n, new_messages: newMessages.n });
      }
      send(res, 200, rows);
      return;
    }

    if (method === "GET" && pathname === "/admin/users") {
      const rows = await dbAll(`
        SELECT u.id, u.username, u.is_admin, u.created_at,
          (SELECT COUNT(*) FROM messages WHERE user_id = u.id AND role = 'user') as msg_count,
          (SELECT COUNT(*) FROM sessions WHERE user_id = u.id AND archived = 0) as session_count,
          (SELECT MAX(created_at) FROM messages WHERE user_id = u.id AND role = 'user') as last_active_at
        FROM users u ORDER BY last_active_at DESC, u.id ASC
      `, []);
      send(res, 200, rows);
      return;
    }

    if (method === "GET" && pathname === "/admin/chat-inspect") {
      const uid = Number(url.searchParams.get("user_id"));
      if (!uid) { send(res, 400, { error: "user_id required" }); return; }
      const [characters, sessions] = await Promise.all([
        dbAll("SELECT id, name, is_active, affection, created_at FROM characters WHERE user_id = ? ORDER BY id DESC", [uid]),
        dbAll(`SELECT s.id, s.title, s.updated_at, s.archived,
          (SELECT content FROM messages WHERE session_id = s.id AND role != 'system' ORDER BY id DESC LIMIT 1) as last_msg,
          (SELECT COUNT(*) FROM messages WHERE session_id = s.id AND role != 'system') as msg_count
          FROM sessions s WHERE s.user_id = ? ORDER BY s.updated_at DESC LIMIT 50`, [uid]),
      ]);
      send(res, 200, { characters, sessions });
      return;
    }

    if (method === "GET" && pathname === "/admin/chat-inspect/messages") {
      const sid = Number(url.searchParams.get("session_id"));
      if (!sid) { send(res, 400, { error: "session_id required" }); return; }
      const msgs = await dbAll("SELECT id, role, content, created_at, image_url FROM messages WHERE session_id = ? AND role != 'system' ORDER BY id ASC", [sid]);
      send(res, 200, msgs);
      return;
    }

    const adminUserMatch = pathname.match(/^\/admin\/users\/(\d+)$/);
    if (method === "PATCH" && adminUserMatch) {
      const uid = Number(adminUserMatch[1]);
      const body = await readBody(req);
      await dbRun("UPDATE users SET is_admin = ? WHERE id = ?", [body.is_admin ? 1 : 0, uid]);
      send(res, 200, { ok: true });
      return;
    }

    if (method === "DELETE" && adminUserMatch) {
      const uid = Number(adminUserMatch[1]);
      if (uid === adminSession.userId) { send(res, 400, { error: "cannot delete yourself" }); return; }
      await dbRun("DELETE FROM announcement_reads WHERE user_id = ?", [uid]);
      await dbRun("DELETE FROM user_settings WHERE user_id = ?", [uid]);
      await dbRun("DELETE FROM users WHERE id = ?", [uid]);
      send(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/admin/invite-codes") {
      const rows = await dbAll("SELECT code, created_at FROM invite_codes ORDER BY created_at DESC", []);
      send(res, 200, rows);
      return;
    }

    if (method === "POST" && pathname === "/admin/invite-codes") {
      const body = await readBody(req);
      const code = String(body.code || "").trim() || crypto.randomBytes(4).toString("hex");
      try {
        await dbRun("INSERT INTO invite_codes (code, created_at) VALUES (?, ?)", [code, nowIso()]);
        send(res, 200, { code });
      } catch {
        send(res, 400, { error: "code already exists" });
      }
      return;
    }

    const adminCodeMatch = pathname.match(/^\/admin\/invite-codes\/(.+)$/);
    if (method === "DELETE" && adminCodeMatch) {
      const code = decodeURIComponent(adminCodeMatch[1]);
      await dbRun("DELETE FROM invite_codes WHERE code = ?", [code]);
      send(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/admin/announcements") {
      const rows = await dbAll("SELECT * FROM announcements ORDER BY created_at DESC", []);
      send(res, 200, rows);
      return;
    }

    if (method === "POST" && pathname === "/admin/announcements") {
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      const content = String(body.content || "").trim();
      if (!title || !content) { send(res, 400, { error: "title and content required" }); return; }
      const result = await dbRun("INSERT INTO announcements (title, content, created_at) VALUES (?, ?, ?)", [title, content, nowIso()]);
      send(res, 200, { id: Number(result.insertId) });
      return;
    }

    const adminAnnMatch = pathname.match(/^\/admin\/announcements\/(\d+)$/);
    if (method === "DELETE" && adminAnnMatch) {
      const annId = Number(adminAnnMatch[1]);
      await dbRun("DELETE FROM announcement_reads WHERE announcement_id = ?", [annId]);
      await dbRun("DELETE FROM announcements WHERE id = ?", [annId]);
      send(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/admin/global-settings") {
      send(res, 200, {
        chat_image_enabled: await getGlobalSetting("chat_image_enabled", "1"),
        daily_scene_image_limit: await getGlobalSetting("daily_scene_image_limit", "5"),
        daily_avatar_image_limit: await getGlobalSetting("daily_avatar_image_limit", "20"),
        affection_interval: await getGlobalSetting("affection_interval", "3"),
        manual_affection_enabled: await getGlobalSetting("manual_affection_enabled", "1"),
        milestone_mode: await getGlobalSetting("milestone_mode", "comic"),
        milestone_video_duration: await getGlobalSetting("milestone_video_duration", "3"),
        deepseek_thinking: await getGlobalSetting("deepseek_thinking", "0"),
        tts_channel: await getGlobalSetting("tts_channel", "qwen"),
        call_min_messages: await getGlobalSetting("call_min_messages", "20"),
        call_idle_minutes: await getGlobalSetting("call_idle_minutes", "5"),
        call_cooldown_minutes: await getGlobalSetting("call_cooldown_minutes", "60"),
        call_emotion_cooldown_minutes: await getGlobalSetting("call_emotion_cooldown_minutes", "120"),
        multi_char_awareness: await getGlobalSetting("multi_char_awareness", "0")
      });
      return;
    }

    if (method === "PATCH" && pathname === "/admin/global-settings") {
      const body = await readBody(req);
      if ("chat_image_enabled" in body) await setGlobalSetting("chat_image_enabled", body.chat_image_enabled ? "1" : "0");
      if ("daily_scene_image_limit" in body) {
        const n = Math.max(0, Math.floor(Number(body.daily_scene_image_limit) || 5));
        await setGlobalSetting("daily_scene_image_limit", String(n));
      }
      if ("daily_avatar_image_limit" in body) {
        const n = Math.max(0, Math.floor(Number(body.daily_avatar_image_limit) || 20));
        await setGlobalSetting("daily_avatar_image_limit", String(n));
      }
      if ("affection_interval" in body) {
        const n = Math.max(1, Math.min(20, Math.floor(Number(body.affection_interval) || 3)));
        await setGlobalSetting("affection_interval", String(n));
      }
      if ("manual_affection_enabled" in body) {
        await setGlobalSetting("manual_affection_enabled", body.manual_affection_enabled ? "1" : "0");
      }
      if ("milestone_mode" in body && ["comic", "video"].includes(body.milestone_mode)) {
        await setGlobalSetting("milestone_mode", body.milestone_mode);
      }
      if ("milestone_video_duration" in body) {
        const n = Math.max(3, Math.min(10, Math.floor(Number(body.milestone_video_duration) || 3)));
        await setGlobalSetting("milestone_video_duration", String(n));
      }
      if ("deepseek_thinking" in body) {
        await setGlobalSetting("deepseek_thinking", body.deepseek_thinking ? "1" : "0");
      }
      if ("tts_channel" in body && ["qwen", "qwen-omni", "cosyvoice"].includes(body.tts_channel)) {
        await setGlobalSetting("tts_channel", body.tts_channel);
      }
      if ("call_min_messages" in body) {
        await setGlobalSetting("call_min_messages", String(Math.max(1, Number(body.call_min_messages) || 20)));
      }
      if ("call_idle_minutes" in body) {
        await setGlobalSetting("call_idle_minutes", String(Math.max(1, Number(body.call_idle_minutes) || 5)));
      }
      if ("call_cooldown_minutes" in body) {
        await setGlobalSetting("call_cooldown_minutes", String(Math.max(1, Number(body.call_cooldown_minutes) || 60)));
      }
      if ("call_emotion_cooldown_minutes" in body) {
        await setGlobalSetting("call_emotion_cooldown_minutes", String(Math.max(1, Number(body.call_emotion_cooldown_minutes) || 120)));
      }
      if ("multi_char_awareness" in body) {
        await setGlobalSetting("multi_char_awareness", body.multi_char_awareness ? "1" : "0");
      }
      send(res, 200, {
        chat_image_enabled: await getGlobalSetting("chat_image_enabled", "1"),
        daily_scene_image_limit: await getGlobalSetting("daily_scene_image_limit", "5"),
        daily_avatar_image_limit: await getGlobalSetting("daily_avatar_image_limit", "20"),
        affection_interval: await getGlobalSetting("affection_interval", "3"),
        manual_affection_enabled: await getGlobalSetting("manual_affection_enabled", "1"),
        milestone_mode: await getGlobalSetting("milestone_mode", "comic"),
        milestone_video_duration: await getGlobalSetting("milestone_video_duration", "3"),
        deepseek_thinking: await getGlobalSetting("deepseek_thinking", "0"),
        tts_channel: await getGlobalSetting("tts_channel", "qwen"),
        call_min_messages: await getGlobalSetting("call_min_messages", "20"),
        call_idle_minutes: await getGlobalSetting("call_idle_minutes", "5"),
        call_cooldown_minutes: await getGlobalSetting("call_cooldown_minutes", "60"),
        call_emotion_cooldown_minutes: await getGlobalSetting("call_emotion_cooldown_minutes", "120"),
        multi_char_awareness: await getGlobalSetting("multi_char_awareness", "0")
      });
      return;
    }

    if (method === "GET" && pathname === "/admin/soul") {
      const soul = fs.existsSync(SOUL_PATH) ? fs.readFileSync(SOUL_PATH, "utf8") : "";
      send(res, 200, { soul });
      return;
    }

    if (method === "PATCH" && pathname === "/admin/soul") {
      const body = await readBody(req);
      const soul = String(body.soul || "");
      fs.writeFileSync(SOUL_PATH, soul, "utf8");
      send(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/admin/achievements") {
      const rows = await dbAll("SELECT * FROM achievements ORDER BY type, threshold", []);
      send(res, 200, rows);
      return;
    }

    if (method === "POST" && pathname === "/admin/achievements") {
      const body = await readBody(req);
      const type = String(body.type || "").trim();
      const threshold = parseInt(body.threshold, 10);
      const name = String(body.name || "").trim();
      if (!type || !name || isNaN(threshold)) { send(res, 400, { error: "type, threshold, name required" }); return; }
      const result = await dbRun("INSERT INTO achievements (type, threshold, name, enabled, created_at) VALUES (?, ?, ?, 1, ?)", [type, threshold, name, nowIso()]);
      send(res, 200, { id: Number(result.insertId) });
      return;
    }

    const adminAchMatch = pathname.match(/^\/admin\/achievements\/(\d+)$/);
    if (adminAchMatch) {
      const achId = Number(adminAchMatch[1]);
      if (method === "PATCH") {
        const body = await readBody(req);
        const fields = [];
        const vals = [];
        if ("enabled" in body) { fields.push("enabled = ?"); vals.push(body.enabled ? 1 : 0); }
        if ("name" in body) { fields.push("name = ?"); vals.push(String(body.name).trim()); }
        if ("threshold" in body) { fields.push("threshold = ?"); vals.push(parseInt(body.threshold, 10)); }
        if ("type" in body) { fields.push("type = ?"); vals.push(String(body.type).trim()); }
        if (!fields.length) { send(res, 400, { error: "nothing to update" }); return; }
        vals.push(achId);
        await dbRun(`UPDATE achievements SET ${fields.join(", ")} WHERE id = ?`, vals);
        send(res, 200, { ok: true });
        return;
      }
      if (method === "DELETE") {
        await dbRun("DELETE FROM achievements WHERE id = ?", [achId]);
        send(res, 200, { ok: true });
        return;
      }
    }

    send(res, 404, { error: "not found" });
    return;
  }

  // GET /character — 返回当前角色名、激活卡片和轮播设置
  if (method === "GET" && pathname === "/character") {
    const char = await getActiveCharacter(userId);
    const name = char?.name || await getCharacterName(userId);
    const row = await dbGet("SELECT image_url FROM character_cards WHERE `character` = ? AND (user_id = ? OR user_id IS NULL) AND is_active = 1", [name, userId]);
    const cardUrl = row?.image_url || null;
    if (!cardUrl) {
      generateCharacterCard(false, userId).then((url) => {
        if (url) pushToUser(userId, { card_update: true, card_url: url });
      });
    }
    send(res, 200, {
      id: char?.id || null,
      name,
      card_url: cardUrl,
      slideshow_enabled: char?.slideshow_enabled === 1,
      slideshow_interval: char?.slideshow_interval ?? 30,
      affection: char?.affection ?? 10
    });
    return;
  }

  // GET /avatars — 返回当前角色所有情绪头像（用于前端刷新缓存）
  if (method === "GET" && pathname === "/avatars") {
    const name = await getCharacterName(userId);
    const appearance = await getCharacterAppearance(userId);
    const appearanceHash = crypto.createHash("md5").update(appearance).digest("hex").slice(0, 8);
    const rows = await dbAll("SELECT mood, image_url, appearance_hash FROM mood_avatars WHERE `character` = ? AND (user_id = ? OR user_id IS NULL)", [name, userId]);
    const avatars = {};
    let stale = false;
    for (const row of rows) {
      avatars[row.mood] = row.image_url;
      if (row.appearance_hash !== appearanceHash) stale = true;
    }
    const quota = await getAvatarQuotaInfo(userId);
    send(res, 200, { character: name, avatars, stale, moods: Object.keys(MOOD_AVATAR_PROMPTS), quota });
    return;
  }

  // POST /avatars/regenerate — 一键重置：删除全部头像 + 重新生成（消耗对应数量配额）
  if (method === "POST" && pathname === "/avatars/regenerate") {
    const name = await getCharacterName(userId);
    if (!name) { send(res, 400, { error: "no character" }); return; }
    const moods = Object.keys(MOOD_AVATAR_PROMPTS);
    const ok = await consumeDailyAvatarQuota(userId, moods.length);
    if (!ok) {
      const q = await getAvatarQuotaInfo(userId);
      send(res, 429, { error: `今日头像配额不足（${q.usedToday}/${q.dailyLimit}）` });
      return;
    }
    await dbRun("DELETE FROM mood_avatars WHERE `character` = ? AND (user_id = ? OR user_id IS NULL)", [name, userId]);
    pregenerateMoodAvatars(name, null, userId).catch(() => {});
    send(res, 202, { ok: true, message: "已开始重新生成全部情绪头像" });
    return;
  }

  // POST /avatars/:mood/regenerate — 重生成单一情绪头像
  const moodRegenMatch = pathname.match(/^\/avatars\/([a-z_]+)\/regenerate$/);
  if (method === "POST" && moodRegenMatch) {
    const mood = moodRegenMatch[1];
    if (!MOOD_AVATAR_PROMPTS[mood]) { send(res, 400, { error: "unknown mood" }); return; }
    const name = await getCharacterName(userId);
    if (!name) { send(res, 400, { error: "no character" }); return; }
    const ok = await consumeDailyAvatarQuota(userId, 1);
    if (!ok) {
      const q = await getAvatarQuotaInfo(userId);
      send(res, 429, { error: `今日头像配额不足（${q.usedToday}/${q.dailyLimit}）` });
      return;
    }
    await dbRun("DELETE FROM mood_avatars WHERE `character` = ? AND mood = ? AND (user_id = ? OR user_id IS NULL)", [name, mood, userId]);
    generateMoodAvatar(mood, userId).then((url) => {
      if (url) pushToUser(userId, { mood_avatar_update: true, mood, avatar_url: url });
    }).catch(() => {});
    send(res, 202, { ok: true });
    return;
  }

  // DELETE /avatars — 清除当前角色所有情绪头像（不重新生成）
  if (method === "DELETE" && pathname === "/avatars") {
    const name = await getCharacterName(userId);
    await dbRun("DELETE FROM mood_avatars WHERE `character` = ? AND (user_id = ? OR user_id IS NULL)", [name, userId]);
    send(res, 200, { ok: true });
    return;
  }

  // GET /character/cards — 卡片历史列表
  if (method === "GET" && pathname === "/character/cards") {
    const name = await getCharacterName(userId);
    const cards = await dbAll("SELECT id, image_url, is_active, created_at FROM character_cards WHERE `character` = ? AND (user_id = ? OR user_id IS NULL) ORDER BY id DESC", [name, userId]);
    send(res, 200, cards);
    return;
  }

  // POST /character/cards/generate — 强制生成新卡片
  if (method === "POST" && pathname === "/character/cards/generate") {
    send(res, 202, { ok: true, message: "生成中" });
    generateCharacterCard(true, userId).then((url) => {
      if (url) pushToUser(userId, { card_update: true, card_url: url });
    });
    return;
  }

  // PATCH /character/cards/:id/activate — 激活指定卡片
  const activateCardMatch = pathname.match(/^\/character\/cards\/(\d+)\/activate$/);
  if (method === "PATCH" && activateCardMatch) {
    const id = Number(activateCardMatch[1]);
    const card = await dbGet("SELECT * FROM character_cards WHERE id = ? AND (user_id = ? OR user_id IS NULL)", [id, userId]);
    if (!card) { send(res, 404, { error: "not found" }); return; }
    await dbRun("UPDATE character_cards SET is_active = 0 WHERE `character` = ? AND (user_id = ? OR user_id IS NULL)", [card.character, userId]);
    await dbRun("UPDATE character_cards SET is_active = 1 WHERE id = ?", [id]);
    pushToUser(userId, { card_update: true, card_url: card.image_url });
    send(res, 200, { ok: true, card_url: card.image_url });
    return;
  }

  // DELETE /character/cards/:id — 删除卡片
  const deleteCardMatch = pathname.match(/^\/character\/cards\/(\d+)$/);
  if (method === "DELETE" && deleteCardMatch) {
    const id = Number(deleteCardMatch[1]);
    const card = await dbGet("SELECT * FROM character_cards WHERE id = ? AND (user_id = ? OR user_id IS NULL)", [id, userId]);
    if (!card) { send(res, 404, { error: "not found" }); return; }
    await dbRun("DELETE FROM character_cards WHERE id = ?", [id]);
    if (card.is_active) {
      const latest = await dbGet("SELECT id FROM character_cards WHERE `character` = ? AND (user_id = ? OR user_id IS NULL) ORDER BY id DESC LIMIT 1", [card.character, userId]);
      if (latest) await dbRun("UPDATE character_cards SET is_active = 1 WHERE id = ?", [latest.id]);
    }
    send(res, 200, { ok: true });
    return;
  }

  // PATCH /character/slideshow — 保存轮播设置
  if (method === "PATCH" && pathname === "/character/slideshow") {
    const body = await readBody(req);
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 404, { error: "no active character" }); return; }
    const enabled = body.enabled ? 1 : 0;
    const interval = Math.max(1, Number(body.interval_minutes) || 30);
    await dbRun("UPDATE characters SET slideshow_enabled = ?, slideshow_interval = ? WHERE id = ?", [enabled, interval, char.id]);
    send(res, 200, { ok: true });
    return;
  }

  // GET /character/affection-log — 心动值变化历史
  if (method === "GET" && pathname === "/character/affection-log") {
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 200, []); return; }
    const rows = await dbAll("SELECT delta, value, mood, reason, created_at FROM affection_log WHERE character_id = ? ORDER BY id DESC LIMIT 50", [char.id]);
    send(res, 200, rows);
    return;
  }

  // GET /achievements — 当前用户已解锁成就列表
  if (method === "GET" && pathname === "/achievements") {
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 200, []); return; }
    const rows = await dbAll(
      `SELECT ua.id, ua.achievement_id, ua.selfie_url, ua.inner_voice, ua.unlocked_at,
              a.name, a.type, a.threshold
       FROM user_achievements ua
       JOIN achievements a ON a.id = ua.achievement_id
       WHERE ua.user_id = ? AND ua.character_id = ?
       ORDER BY ua.unlocked_at DESC`,
      [userId, char.id]
    );
    send(res, 200, rows);
    return;
  }

  // GET /achievements/pending — 已生成但未通知的成就
  if (method === "GET" && pathname === "/achievements/pending") {
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 200, []); return; }
    const rows = await dbAll(
      `SELECT ua.id, ua.selfie_url, ua.inner_voice,
              a.id as achievement_id, a.name, a.type, a.threshold
       FROM user_achievements ua
       JOIN achievements a ON a.id = ua.achievement_id
       WHERE ua.user_id = ? AND ua.character_id = ? AND ua.notified = 0 AND ua.selfie_url IS NOT NULL`,
      [userId, char.id]
    );
    send(res, 200, rows);
    return;
  }

  // POST /achievements/notify — 标记成就已通知
  if (method === "POST" && pathname === "/achievements/notify") {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    if (ids.length) {
      await dbRun(
        `UPDATE user_achievements SET notified = 1 WHERE id IN (${ids.map(() => "?").join(",")}) AND user_id = ?`,
        [...ids, userId]
      );
    }
    send(res, 200, { ok: true });
    return;
  }

  // GET /relationship/milestones — 所有关系里程碑（用于回看）
  if (method === "GET" && pathname === "/relationship/milestones") {
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 200, []); return; }
    const rows = await dbAll(
      "SELECT * FROM relationship_milestones WHERE user_id = ? AND character_id = ? ORDER BY stage ASC",
      [userId, char.id]
    );
    send(res, 200, rows);
    return;
  }

  // POST /relationship/milestones/:id/notify — 标记已通知
  const milestoneNotifyMatch = pathname.match(/^\/relationship\/milestones\/(\d+)\/notify$/);
  if (method === "POST" && milestoneNotifyMatch) {
    const id = Number(milestoneNotifyMatch[1]);
    await dbRun("UPDATE relationship_milestones SET notified = 1 WHERE id = ? AND user_id = ?", [id, userId]);
    send(res, 200, { ok: true });
    return;
  }
  if (method === "PATCH" && pathname === "/character/affection") {
    const manualEnabled = (await getGlobalSetting("manual_affection_enabled", "1")) !== "0";
    if (!manualEnabled) { send(res, 403, { error: "manual affection disabled" }); return; }
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 404, { error: "no active character" }); return; }
    const body = await readBody(req);
    const value = Math.max(0, Math.min(100, parseInt(body.value, 10)));
    if (isNaN(value)) { send(res, 400, { error: "invalid value" }); return; }
    const prev = char.affection ?? 10;
    const delta = value - prev;
    await dbRun("UPDATE characters SET affection = ? WHERE id = ?", [value, char.id]);
    if (delta !== 0) {
      await dbRun("INSERT INTO affection_log (character_id, delta, value, mood, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)", [char.id, delta, value, null, "手动设置", nowIso()]);
    }
    const sessions = await dbGet("SELECT id FROM sessions WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1", [userId]);
    if (sessions) pushToSession(sessions.id, { affection_update: true, affection: value, delta });
    if (delta !== 0) {
      const settings = await getUserSettings(userId);
      checkRelationshipMilestone(userId, sessions?.id ?? null, prev, value, settings).catch(() => {});
    }
    send(res, 200, { affection: value });
    return;
  }

  if (method === "GET" && pathname === "/character/soul") {
    try {
      const char = await getActiveCharacter(userId);
      if (!char) {
        const fileSoul = loadSoulFromFile();
        send(res, 200, { soul: fileSoul || "", character_id: null, name: "", appearance: "", personality: "", description: "" });
        return;
      }
      send(res, 200, {
        character_id: char.id,
        name: char.name || "",
        appearance: char.appearance || "",
        personality: char.personality || "",
        description: char.description || "",
        soul: char.soul_content || ""
      });
    } catch (e) {
      send(res, 404, { error: e.message });
    }
    return;
  }

  // PATCH /character/soul — 保存激活角色结构化字段
  if (method === "PATCH" && pathname === "/character/soul") {
    const body = await readBody(req);
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 404, { error: "no active character" }); return; }
    const appearanceChanged = typeof body.appearance === "string" && body.appearance.trim() !== (char.appearance || "");
    if (typeof body.name === "string") await dbRun("UPDATE characters SET name = ? WHERE id = ?", [body.name.trim(), char.id]);
    if (typeof body.appearance === "string") await dbRun("UPDATE characters SET appearance = ? WHERE id = ?", [body.appearance.trim(), char.id]);
    if (typeof body.personality === "string") await dbRun("UPDATE characters SET personality = ? WHERE id = ?", [body.personality.trim(), char.id]);
    if (typeof body.description === "string") await dbRun("UPDATE characters SET description = ? WHERE id = ?", [body.description.trim(), char.id]);
    if (typeof body.soul === "string") await dbRun("UPDATE characters SET soul_content = ? WHERE id = ?", [body.soul.trim(), char.id]);
    send(res, 200, { ok: true, id: char.id });
    // 外貌变了，后台重新生成所有情绪头像
    if (appearanceChanged) {
      const updatedName = typeof body.name === "string" ? body.name.trim() : char.name;
      pregenerateMoodAvatars(updatedName, null, userId).catch(() => {});
    }
    return;
  }

  // GET /character/voice
  if (method === "GET" && pathname === "/character/voice") {
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 200, { voice_id: null, tts_enabled: 0, voice_channel: "qwen" }); return; }
    send(res, 200, { voice_id: char.voice_id || null, tts_enabled: char.tts_enabled || 0, voice_channel: char.voice_channel || "qwen" });
    return;
  }

  // PATCH /character/voice — 更新 tts_enabled
  if (method === "PATCH" && pathname === "/character/voice") {
    const body = await readBody(req);
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 404, { error: "no active character" }); return; }
    if ("tts_enabled" in body) {
      await dbRun("UPDATE characters SET tts_enabled = ? WHERE id = ?", [body.tts_enabled ? 1 : 0, char.id]);
    }
    send(res, 200, { ok: true });
    return;
  }

  // POST /character/voice — 上传音频，复刻音色
  if (method === "POST" && pathname === "/character/voice") {
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 404, { error: "no active character" }); return; }
    const MAX_VOICE_BYTES = 20 * 1024 * 1024;
    const declared = Number(req.headers["content-length"] || 0);
    if (declared && declared > MAX_VOICE_BYTES) {
      send(res, 413, { error: "音频文件过大，最大 20MB" });
      return;
    }
    const chunks = [];
    let total = 0;
    let aborted = false;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_VOICE_BYTES) {
        aborted = true;
        try { req.destroy(); } catch {}
        break;
      }
      chunks.push(chunk);
    }
    if (aborted) { send(res, 413, { error: "音频文件过大，最大 20MB" }); return; }
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) { send(res, 400, { error: "empty body" }); return; }
    const ct = req.headers["content-type"] || "";
    const extMap = { "audio/wav": ".wav", "audio/wave": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".mp4", "audio/m4a": ".m4a", "audio/ogg": ".ogg", "audio/webm": ".webm" };
    const ext = extMap[ct.split(";")[0].trim()] || ".wav";
    const channel = await getGlobalSetting("tts_channel", "qwen");
    const filename = `voice-sample-${char.id}-${Date.now()}${ext}`;
    const ossUrl = await uploadToOss(buf, filename);
    const voiceId = channel === "cosyvoice"
      ? await cloneVoiceCosyVoice(ossUrl, char.id)
      : channel === "qwen-omni"
        ? await cloneVoiceQwenOmni(ossUrl, char.id)
        : await cloneVoice(ossUrl, char.id);
    // 若已有旧音色，异步删除
    if (char.voice_id) {
      const oldChannel = char.voice_channel || "qwen";
      (oldChannel === "cosyvoice" ? deleteVoiceCosyVoice : oldChannel === "qwen-omni" ? deleteVoiceQwenOmni : deleteVoice)(char.voice_id).catch(() => {});
    }
    await dbRun("UPDATE characters SET voice_id = ?, voice_channel = ?, tts_enabled = 1, voice_preview_url = NULL WHERE id = ?", [voiceId, channel, char.id]);
    send(res, 200, { voice_id: voiceId, voice_channel: channel });
    return;
  }

  // DELETE /character/voice — 删除音色
  if (method === "DELETE" && pathname === "/character/voice") {
    const char = await getActiveCharacter(userId);
    if (!char) { send(res, 404, { error: "no active character" }); return; }
    if (char.voice_id) {
      const ch = char.voice_channel || "qwen";
      (ch === "cosyvoice" ? deleteVoiceCosyVoice : ch === "qwen-omni" ? deleteVoiceQwenOmni : deleteVoice)(char.voice_id).catch(() => {});
    }
    await dbRun("UPDATE characters SET voice_id = NULL, tts_enabled = 0, voice_preview_url = NULL WHERE id = ?", [char.id]);
    send(res, 200, { ok: true });
    return;
  }

  // POST /character/voice/preview — 试听
  if (method === "POST" && pathname === "/character/voice/preview") {
    const char = await getActiveCharacter(userId);
    if (!char?.voice_id) { send(res, 400, { error: "no voice" }); return; }
    if (char.voice_preview_url) {
      send(res, 200, { audio_url: char.voice_preview_url });
      return;
    }
    const userSettings = await getUserSettings(userId);
    const lang = userSettings.ttsLang || "zh";
    let text = "你好，我是你的专属伴侣，很高兴认识你。";
    if (lang === "ja") text = await translateToJapanese(text);
    try {
      const synthFn = (char.voice_channel || "qwen") === "cosyvoice" ? synthesizeSpeechCosyVoice : (char.voice_channel || "qwen") === "qwen-omni" ? synthesizeSpeechQwenOmni : synthesizeSpeech;
      const { url: audioUrl } = await synthFn(text, char.voice_id, lang);
      await dbRun("UPDATE characters SET voice_preview_url = ? WHERE id = ?", [audioUrl, char.id]);
      send(res, 200, { audio_url: audioUrl });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
    return;
  }

  // GET /characters — 角色列表
  if (method === "GET" && pathname === "/characters") {
    const rows = await dbAll(
      "SELECT c.id, c.name, c.is_active, c.created_at, " +
      "(SELECT image_url FROM mood_avatars WHERE `character` = c.name AND (user_id = c.user_id OR user_id IS NULL) ORDER BY (mood='neutral') DESC, id DESC LIMIT 1) as avatar_url " +
      "FROM characters c WHERE c.user_id = ? ORDER BY c.id ASC",
      [userId]
    );
    send(res, 200, rows);
    return;
  }

  // GET /characters/:id — 单个角色详情（含 soul_content 与结构化字段）
  const charGetMatch = pathname.match(/^\/characters\/(\d+)$/);
  if (method === "GET" && charGetMatch) {
    const charId = Number(charGetMatch[1]);
    const row = await dbGet("SELECT id, name, appearance, personality, description, soul_content, is_active, created_at FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
    if (!row) { send(res, 404, { error: "not found" }); return; }
    send(res, 200, row);
    return;
  }

  // POST /characters — 新建角色
  if (method === "POST" && pathname === "/characters") {
    const body = await readBody(req);
    if (!body.name?.trim()) { send(res, 400, { error: "name required" }); return; }
    const soul = body.soul_content || `# 角色名称\n\n${body.name.trim()}\n\n# 外貌\n\n# 性格\n\n# 说话方式\n\n`;
    const result = await dbRun(
      "INSERT INTO characters (name, soul_content, is_active, created_at, user_id) VALUES (?, ?, 0, ?, ?)",
      [body.name.trim(), soul, nowIso(), userId]
    );
    send(res, 200, { id: result.insertId, name: body.name.trim() });
    return;
  }

  // PATCH /characters/:id — 更新角色（名称/soul/激活状态）
  const charEditMatch = pathname.match(/^\/characters\/(\d+)$/);
  if (method === "PATCH" && charEditMatch) {
    const charId = Number(charEditMatch[1]);
    const body = await readBody(req);
    const existing = await dbGet("SELECT * FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
    if (!existing) { send(res, 404, { error: "not found" }); return; }
    const appearanceChanged = typeof body.appearance === "string" && body.appearance.trim() !== (existing.appearance || "");
    if (body.is_active) {
      await dbRun("UPDATE characters SET is_active = 0 WHERE user_id = ?", [userId]);
      await dbRun("UPDATE characters SET is_active = 1 WHERE id = ? AND user_id = ?", [charId, userId]);
      const activated = await dbGet("SELECT name FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
      if (activated) pregenerateMoodAvatars(activated.name, null, userId).catch(() => {});
    }
    if (typeof body.name === "string") await dbRun("UPDATE characters SET name = ? WHERE id = ? AND user_id = ?", [body.name.trim(), charId, userId]);
    if (typeof body.appearance === "string") await dbRun("UPDATE characters SET appearance = ? WHERE id = ? AND user_id = ?", [body.appearance.trim(), charId, userId]);
    if (typeof body.personality === "string") await dbRun("UPDATE characters SET personality = ? WHERE id = ? AND user_id = ?", [body.personality.trim(), charId, userId]);
    if (typeof body.description === "string") await dbRun("UPDATE characters SET description = ? WHERE id = ? AND user_id = ?", [body.description.trim(), charId, userId]);
    if (typeof body.soul_content === "string") await dbRun("UPDATE characters SET soul_content = ? WHERE id = ? AND user_id = ?", [body.soul_content.trim(), charId, userId]);
    send(res, 200, { ok: true });
    if (appearanceChanged) {
      const finalName = typeof body.name === "string" ? body.name.trim() : existing.name;
      pregenerateMoodAvatars(finalName, null, userId).catch(() => {});
    }
    return;
  }

  // DELETE /characters/:id — 删除角色（不能删激活的）
  if (method === "DELETE" && charEditMatch) {
    const charId = Number(charEditMatch[1]);
    const char = await dbGet("SELECT * FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
    if (!char) { send(res, 404, { error: "not found" }); return; }
    if (char.is_active) { send(res, 400, { error: "cannot delete active character" }); return; }
    await dbRun("DELETE FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
    send(res, 200, { ok: true });
    return;
  }

  // 上传图片的静态服务
  const uploadsMatch = pathname.match(/^\/uploads\/(.+)$/);
  if (method === "GET" && uploadsMatch) {
    const filePath = path.join(UPLOADS_DIR, uploadsMatch[1]);
    if (!filePath.startsWith(UPLOADS_DIR) || !fs.existsSync(filePath)) {
      send(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
    res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream", "Cache-Control": "public, max-age=86400" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // POST /sessions/:id/image — 用户发图
  const imgUploadMatch = pathname.match(/^\/sessions\/(\d+)\/image$/);
  if (method === "POST" && imgUploadMatch) {
    const sessionId = Number(imgUploadMatch[1]);
    if (!await getSession(sessionId, userId)) {
      send(res, 404, { error: "session not found" });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) {
      send(res, 400, { error: "empty body" });
      return;
    }
    const ext = (req.headers["content-type"] || "").includes("png") ? ".png" : ".jpg";
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    const filename = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
    // 直传 OSS，不再落本地磁盘
    let imageUrl;
    try {
      imageUrl = await uploadToOss(buf, filename, mimeType);
    } catch (err) {
      console.error(`[user-image] OSS 上传失败: ${err.message}`);
      send(res, 500, { error: "上传失败" });
      return;
    }
    const msgId = await appendMessage(sessionId, "user", "[图片]", null, userId);
    await updateMessageImage(msgId, imageUrl);

    // 异步识别图片内容（不阻塞响应，避免前端长时间等）
    const base64 = buf.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;
    recognizeImage(dataUrl).then(async (desc) => {
      if (desc) {
        await updateMessageImagePrompt(msgId, desc);
        await appendMessage(sessionId, "user", `（我发了一张图片，图片内容是：${desc}）`, null, userId);
        console.log(`用户图片识别 [msg ${msgId}]: ${desc}`);
      }
    }).catch(() => {});

    send(res, 200, { ok: true, msg_id: Number(msgId), image_url: imageUrl });
    return;
  }

  // POST /sessions/:id/scene-image — 手动生成当前场景插图
  const sceneImgMatch = pathname.match(/^\/sessions\/(\d+)\/scene-image$/);
  if (method === "POST" && sceneImgMatch) {
    const sessionId = Number(sceneImgMatch[1]);
    if (!await getSession(sessionId, userId)) { send(res, 404, { error: "session not found" }); return; }

    // 每日配额检查
    if (!await consumeDailyImageQuota(userId)) {
      const dailyLimit = Number(await getGlobalSetting("daily_scene_image_limit", "5"));
      send(res, 429, { error: "daily_limit_reached", limit: dailyLimit });
      return;
    }

    const settings = await getUserSettings(userId);
    const imageFallbackEnabled = settings.imageFallbackEnabled;
    // 找最近一条 assistant 消息作为场景依据
    const lastAssist = await dbGet("SELECT id, content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [sessionId]);
    if (!lastAssist) { send(res, 400, { error: "no assistant message" }); return; }
    const recentMsgs = await dbAll("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10", [sessionId]);
    recentMsgs.reverse();
    const previousScene = await getLastImagePrompt(sessionId);
    const prompt = await generateImagePrompt("", lastAssist.content, recentMsgs, previousScene, userId);
    // 在最近 assistant 消息上附图（若已有图则新建一条空消息）
    let targetMsgId = lastAssist.id;
    const existing = await dbGet("SELECT image_url FROM messages WHERE id = ?", [targetMsgId]);
    if (existing?.image_url) {
      targetMsgId = await appendMessage(sessionId, "assistant", "", null, userId);
    }
    pushToSession(sessionId, { image_pending: true, msg_id: targetMsgId });
    const reqAspect = url.searchParams.get("aspect") || "";
    const aspect = ["1:1", "2:3", "9:16", "16:9"].includes(reqAspect) ? reqAspect : null;
    fireImageGeneration(targetMsgId, prompt, sessionId, { silent: false, imageFallbackEnabled, userId, aspectRatio: aspect });
    send(res, 200, { ok: true, msg_id: targetMsgId });
    return;
  }
  if (method === "GET" && pathname === "/call-logs") {
    const activeChar = await getActiveCharacter(userId);
    const rows = await dbAll(
      "SELECT id, session_id, char_name, script, audio_url, answered, created_at FROM call_logs WHERE user_id = ? AND char_name = ? ORDER BY id DESC LIMIT 50",
      [userId, activeChar?.name || ""]
    );
    send(res, 200, rows);
    return;
  }

  const callLogAnswerMatch = pathname.match(/^\/call-logs\/(\d+)\/answer$/);
  if (method === "POST" && callLogAnswerMatch) {
    const logId = Number(callLogAnswerMatch[1]);
    const log = await dbGet("SELECT msg_id, script FROM call_logs WHERE id = ? AND user_id = ?", [logId, userId]);
    await dbRun("UPDATE call_logs SET answered = 1 WHERE id = ? AND user_id = ?", [logId, userId]);
    if (log?.msg_id && log?.script) {
      await dbRun("UPDATE messages SET content = ? WHERE id = ?", [`📞 [已接听] ${log.script}`, log.msg_id]);
    }
    send(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/call-logs/unread-voicemail") {
    const activeChar = await getActiveCharacter(userId);
    const logs = await dbAll(
      "SELECT id, session_id, char_name, voicemail, created_at FROM call_logs WHERE user_id = ? AND char_name = ? AND missed = 1 AND voicemail_read = 0 ORDER BY id DESC",
      [userId, activeChar?.name || ""]
    );
    send(res, 200, { count: logs.length, logs });
    return;
  }

  const callLogMissedMatch = pathname.match(/^\/call-logs\/(\d+)\/missed$/);
  if (method === "POST" && callLogMissedMatch) {
    const logId = Number(callLogMissedMatch[1]);
    const log = await dbGet("SELECT * FROM call_logs WHERE id = ? AND user_id = ?", [logId, userId]);
    if (log && !log.answered && !log.missed) {
      console.log(`[未接来电] user=${userId} call_log=${logId} char=${log.char_name} 生成留言中`);
      const voicemail = await generateVoicemail(log.session_id, userId, log.char_name).catch(() => null);
      if (voicemail) {
        await appendMessage(log.session_id, "assistant", `📱 ${voicemail}`, log.char_name, userId);
        await dbRun("UPDATE call_logs SET missed = 1, voicemail = ? WHERE id = ?", [voicemail, logId]);
        console.log(`[未接来电] user=${userId} call_log=${logId} 留言已写入`);
      } else {
        await dbRun("UPDATE call_logs SET missed = 1 WHERE id = ?", [logId]);
        console.log(`[未接来电] user=${userId} call_log=${logId} 留言生成失败，仅标记 missed`);
      }
      // 消息内容已初始化为 [未接听]，无需再更新
    }
    send(res, 200, { ok: true });
    return;
  }

  const callLogVoicemailReadMatch = pathname.match(/^\/call-logs\/(\d+)\/voicemail-read$/);
  if (method === "POST" && callLogVoicemailReadMatch) {
    const logId = Number(callLogVoicemailReadMatch[1]);
    await dbRun("UPDATE call_logs SET voicemail_read = 1 WHERE id = ? AND user_id = ?", [logId, userId]);
    send(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/sessions") {
    send(res, 200, await listSessions(userId));
    return;
  }

  // POST /sessions
  if (method === "POST" && pathname === "/sessions") {
    const body = await readBody(req);
    const session = await createSession(userId, body.title || "新对话");
    send(res, 200, session);
    return;
  }

  // DELETE /sessions/:id
  const deleteMatch = pathname.match(/^\/sessions\/(\d+)$/);
  if (method === "DELETE" && deleteMatch) {
    const id = Number(deleteMatch[1]);
    await deleteSession(id, userId);
    send(res, 200, { ok: true });
    return;
  }

  // POST /sessions/:id/restore
  const restoreMatch = pathname.match(/^\/sessions\/(\d+)\/restore$/);
  if (method === "POST" && restoreMatch) {
    const id = Number(restoreMatch[1]);
    await restoreSession(id, userId);
    send(res, 200, { ok: true });
    return;
  }

  // GET /sessions/archived
  if (method === "GET" && pathname === "/sessions/archived") {
    const rows = await dbAll(`
      SELECT s.*, (SELECT content FROM messages WHERE session_id = s.id AND role != 'system' ORDER BY id DESC LIMIT 1) as last_message
      FROM sessions s WHERE s.archived = 1 AND s.user_id = ? ORDER BY updated_at DESC
    `, [userId]);
    send(res, 200, rows);
    return;
  }

  // POST /sessions/:id/ingest  (由用户主动触发，将对话存入 memory-ai)
  const ingestMatch = pathname.match(/^\/sessions\/(\d+)\/ingest$/);
  if (method === "POST" && ingestMatch) {
    const id = Number(ingestMatch[1]);
    const msgs = await getMessages(id);
    if (msgs.length === 0) {
      send(res, 200, { ok: true, skipped: true });
      return;
    }
    const charName = await getCharacterName(userId);
    const lines = msgs.map((m) => `${m.role === "user" ? "用户" : charName}：${m.content}`);
    await ingestToMemory(`与${charName}的虚拟陪伴对话记录\n\n${lines.join("\n")}`, charName, userId);
    send(res, 200, { ok: true });
    return;
  }
  const patchMatch = pathname.match(/^\/sessions\/(\d+)$/);
  if (method === "PATCH" && patchMatch) {
    const id = Number(patchMatch[1]);
    const body = await readBody(req);
    if (body.title) await renameSession(id, body.title, userId);
    send(res, 200, await getSession(id, userId));
    return;
  }

  // GET /sessions/:id/messages
  const msgsMatch = pathname.match(/^\/sessions\/(\d+)\/messages$/);
  if (method === "GET" && msgsMatch) {
    const id = Number(msgsMatch[1]);
    send(res, 200, await getMessages(id));
    return;
  }

  // POST /sessions/:id/chat
  const chatMatch = pathname.match(/^\/sessions\/(\d+)\/chat$/);
  if (method === "POST" && chatMatch) {
    const sessionId = Number(chatMatch[1]);
    const session = await getSession(sessionId, userId);
    if (!session) {
      send(res, 404, { error: "session not found" });
      return;
    }

    const body = await readBody(req);
    const userText = String(body.message || "").trim();
    if (!userText) {
      send(res, 400, { error: "missing message" });
      return;
    }

    // 存用户消息
    const userMsgId = await appendMessage(sessionId, "user", userText, null, userId);
    const t_total = Date.now();

    // 如果是第一条消息，把对话标题设为用户首句（截断）
    const allMsgs = await getMessages(sessionId);
    if (allMsgs.filter((m) => m.role === "user").length === 1) {
      await renameSession(sessionId, userText.slice(0, 30), userId);
    }

    // 记录用户最后活跃时间
    await touchLastUserAt(sessionId);

    // 组装上下文（最近 20 条）
    const recent = allMsgs;

    // 先判断是否需要查长期记忆，需要时再发请求
    let memoryContext = null;
    const charName = await getCharacterName(userId);
    const char = await getActiveCharacter(userId);
    const shouldLookup = await needsMemoryLookup(userText, recent);
    const [entityGraph, bgMemory, relMemory, diary, behaviorHint] = await Promise.all([
      queryEntityGraph(charName, userId),
      shouldLookup ? queryMemory(`关于这个用户，我们聊过什么，他有哪些值得记住的事情`, charName, userId) : Promise.resolve(null),
      shouldLookup ? queryMemory(userText, charName, userId) : Promise.resolve(null),
      getLatestDiary(userId, char?.id),
      detectBehaviorPattern(userId, sessionId)
    ]);
    if (shouldLookup) {
      console.log("查询记忆中...");
      const memoryParts = [];
      if (bgMemory) memoryParts.push(bgMemory);
      if (relMemory && relMemory !== bgMemory) memoryParts.push(relMemory);
      memoryContext = memoryParts.join("\n\n---\n\n") || null;
      console.log(`[memory] 查询完成，${memoryContext ? "有记忆" : "无记忆"}`);
    }
    if (entityGraph) console.log(`[memory] 实体图谱已加载，${entityGraph.split("\n").length} 条关系`);
    if (diary) console.log(`[diary] 注入日记: ${diary.slice(0, 40)}...`);
    if (behaviorHint) console.log(`[behavior] ${behaviorHint}`);

    const soul = await loadSoul(userId);
    const previousScene = await getLastImagePrompt(sessionId);
    const { mood, topic_summary: topicSummary } = await getSession(sessionId, userId);
    const affection = char?.affection ?? null;
    const achievementStage = char ? await getAchievementStage(userId, char.id) : 0;

    // 多角色感知：若开启，注入其他角色信息
    let otherChars = null;
    const multiCharEnabled = (await getGlobalSetting("multi_char_awareness", "0")) === "1";
    if (multiCharEnabled && char) {
      const allChars = await dbAll("SELECT name FROM characters WHERE user_id = ? AND is_active = 0 ORDER BY id DESC LIMIT 5", [userId]);
      if (allChars.length) otherChars = allChars;
    }

    // 情绪低落检测：好感度 > 60 时，先判断是否触发来电，若触发则跳过 LLM 回复
    if ((affection ?? 0) > 60) {
      const emotionCooldownMs = Number(await getGlobalSetting("call_emotion_cooldown_minutes", "120")) * 60000;
      const sessionForEmotion = await getSession(sessionId);
      const lastEmotionCallAt = sessionForEmotion?.last_emotion_call_at;
      const cooldownOk = !lastEmotionCallAt || Date.now() - new Date(lastEmotionCallAt).getTime() >= emotionCooldownMs;
      if (cooldownOk) {
        const isLow = await detectLowMood(userText);
        console.log(`[情绪来电] user=${userId} affection=${affection} 情绪检测=${isLow ? "低落" : "正常"}`);
        if (isLow) {
          await dbRun("UPDATE sessions SET last_emotion_call_at = ? WHERE id = ?", [nowIso(), sessionId]);
          // 跳过 LLM 回复，直接触发来电
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
          res.write(`data: ${JSON.stringify({ done: true, msg_id: null, user_msg_id: Number(userMsgId), skip_reply: true })}\n\n`);
          res.end();
          triggerSpecialCall(sessionId, userId, "emotion", null, { skipSessionCooldown: true }).catch((e) => console.error("[情绪来电] 触发失败:", e.message));
          return;
        }
      } else {
        console.log(`[情绪来电] user=${userId} 冷却中（上次=\${toLocal(lastEmotionCallAt)}），跳过`);
      }
    }

    const systemPrompt = buildSystemPrompt(soul, memoryContext, previousScene, mood, topicSummary, affection, entityGraph, achievementStage, otherChars, diary, behaviorHint);
    const messages = [
      { role: "system", content: systemPrompt },
      ...recent.map((m) => ({ role: m.role, content: m.content }))
    ];

    // SSE 流式响应
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*"
    });

    try {
    let fullReply = "";
    const ttsChar = await getActiveCharacter(userId);
    const ttsSettings = await getUserSettings(userId);
    try {
      console.log(`[chat] 开始 LLM 请求 provider=${ttsSettings.llmProvider}`);
      const { stream, t0 } = await llmChatStream(messages, ttsSettings.llmProvider);
      let firstContent = false;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          if (!firstContent) process.stdout.write("·");
        }
        const text = delta.content || "";
        if (text) {
          if (!firstContent) {
            firstContent = true;
            console.log(`[chat] 首包延迟 ${Date.now() - t0}ms`);
          }
          fullReply += text;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }
    } catch (err) {
      console.error(`[chat] LLM 请求失败: ${err.message}`);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
      return;
    }

    // 提取图片标记，存纯文字到数据库
    let { cleanText, prompt: imgPrompt } = extractImageTag(fullReply);
    let imgSilent = false;

    if (!ttsSettings.chatImageEnabled) {
      // 关闭聊天插图时，忽略所有图片生成
      imgPrompt = null;
    } else {
      // 兜底：角色回复或用户消息暗示要发图但没带 [IMG:] 标记，根据上下文生成描述
      if (!imgPrompt) {
        const replyHasPhoto = /拍了|给你看|发你|自拍|拍好了|拍的|拍一张|拍给你|发给你|照片|看看/.test(cleanText);
        const userAskedPhoto = /拍|自拍|照片|发图|看看你|发一张|给我看/.test(userText);
        if (replyHasPhoto || userAskedPhoto) {
          console.log("检测到拍照意图但没带标记，用 LLM 生成图片描述");
          try {
            imgPrompt = await generateImagePrompt(userText, cleanText, recent, previousScene, userId);
          } catch (err) {
            console.error("生成图片描述失败:", err.message);
            imgPrompt = "selfie photo, casual pose, natural lighting";
          }
        }
      }

      // 再次兜底：没有显式/启发式插图时，让 AI 判断是否静默插图
      // 冷却：最近 6 条 assistant 消息里已有图片则跳过，避免每轮都发图
      if (!imgPrompt) {
        const recentImgCount = recent.slice(-6).filter((m) => m.role === "assistant" && m.image_url).length;
        if (recentImgCount === 0) {
          const autoPrompt = await decideAutoImage(userText, cleanText, recent, previousScene, userId);
          if (autoPrompt) {
            imgPrompt = autoPrompt;
            imgSilent = true;
          }
        }
      }
    }

    const msgId = await appendMessage(sessionId, "assistant", cleanText, await getCharacterName(userId), userId);

    // 通知前端文字完成，附带图片状态
    const donePayload = { done: true, msg_id: Number(msgId), user_msg_id: Number(userMsgId) };
    let quotaAllowed = false;
    if (imgPrompt) {
      quotaAllowed = await consumeDailyImageQuota(userId);
      if (quotaAllowed) {
        donePayload.image_pending = true;
        donePayload.image_silent = imgSilent;
      } else {
        console.log(`[自动插图] 用户 ${userId} 今日配额已用完，跳过`);
      }
    }

    res.write(`data: ${JSON.stringify(donePayload)}\n\n`);

    if (imgPrompt && quotaAllowed) {
      fireImageGeneration(Number(msgId), imgPrompt, sessionId, { silent: imgSilent, previousScene, imageFallbackEnabled: ttsSettings.imageFallbackEnabled, userId });
    }

    // 异步更新情绪和话题摘要（不阻塞响应）
    const updatedMsgs = await getMessages(sessionId);
    updateMood(sessionId, updatedMsgs, userId).catch(() => {});
    // 每 6 轮更新一次话题摘要
    const userMsgCount = updatedMsgs.filter((m) => m.role === "user").length;
    if (userMsgCount % 6 === 0 || userMsgCount <= 2) {
      updateTopicSummary(sessionId, updatedMsgs, userId).catch(() => {});
    }
    // 每 N 轮更新一次心动值
    const affectionInterval = Number(await getGlobalSetting("affection_interval", "3")) || 3;
    if (userMsgCount % affectionInterval === 0 && userMsgCount > 0) {
      updateAffection(sessionId, updatedMsgs, userId).catch((e) => console.error("[affection] 调用失败:", e.message));
    }
    updateStreakDays(userId).catch(() => {});
    checkAndUnlockAchievements(userId, sessionId, await getUserSettings(userId)).catch((e) => console.error("[achievements] 调用失败:", e.message));
    // 异步 TTS 合成，合成完通过 WS 推送播放
    console.log(`[tts] 检查条件 ttsEnabled=${ttsSettings.ttsEnabled} voice_id=${ttsChar?.voice_id || "无"}`);
    if (ttsSettings.ttsEnabled && ttsChar?.voice_id) {
      (async () => {
        try {
          const stripped = cleanText
            .replace(/[（(][^）)]{0,80}[）)]/g, "")
            .replace(/[【\[][^\]】]{0,80}[\]】]/g, "")
            .replace(/\*[^*]{0,80}\*/g, "")
            .replace(/\s{2,}/g, " ")
            .trim()
            .slice(0, 300);
          if (!stripped) return;
          const lang = ttsSettings.ttsLang || "zh";
          let ttsInput = stripped;
          if (lang === "ja") ttsInput = await translateToJapanese(stripped);
          const instruction = await generateTtsInstruction(char?.name || "", char?.personality || "", mood, recent).catch(() => "");
          console.log(`[tts] 开始合成 lang=${lang} chars=${ttsInput.length} instruction="${instruction}"`);
          // 客户端声明不支持流式 PCM（如 RN App）时强制走非流式渠道
          const allowStreamTts = req.headers["x-stream-tts"] !== "0";
          const ch = (allowStreamTts ? (ttsChar.voice_channel || "qwen") : (ttsChar.voice_channel === "cosyvoice" ? "qwen" : (ttsChar.voice_channel || "qwen")));
          let audioUrl;
          if (ch === "cosyvoice") {
            pushToUser(userId, { tts_stream_start: true, msg_id: Number(msgId) });
            const { url } = await synthesizeSpeechCosyVoice(
              ttsInput, ttsChar.voice_id, lang, instruction,
              (chunk) => pushToUser(userId, { tts_chunk: true, msg_id: Number(msgId), data: chunk.toString("base64") })
            );
            audioUrl = url;
            pushToUser(userId, { tts_stream_end: true, msg_id: Number(msgId), audio_url: audioUrl });
          } else {
            const { url } = ch === "qwen-omni"
              ? await synthesizeSpeechQwenOmni(ttsInput, ttsChar.voice_id, lang, instruction)
              : await synthesizeSpeech(ttsInput, ttsChar.voice_id, lang, instruction);
            audioUrl = url;
            pushToUser(userId, { tts: true, msg_id: Number(msgId), audio_url: audioUrl });
          }
          console.log(`[tts] 合成完成 url=${audioUrl}`);
          await dbRun("UPDATE messages SET tts_audio_url = ? WHERE id = ?", [audioUrl, msgId]);
        } catch (err) {
          console.error("[tts] 合成失败:", err.message);
        }
      })();
    }

    res.end();
    } catch (sseErr) {
      console.error("[chat] SSE 处理异常:", sseErr.message);
      try { res.write(`data: ${JSON.stringify({ error: sseErr.message })}\n\n`); } catch {}
      try { res.end(); } catch {}
    }
    return;
  }

  // GET /messages/:id/image — 前端轮询图片生成状态
  const imgPollMatch = pathname.match(/^\/messages\/(\d+)\/image$/);
  if (method === "GET" && imgPollMatch) {
    const msgId = Number(imgPollMatch[1]);
    const row = await dbGet("SELECT content, image_url FROM messages WHERE id = ?", [msgId]);
    if (!row) {
      send(res, 404, { error: "message not found" });
      return;
    }
    if (row.image_url) {
      send(res, 200, { status: "ready", url: row.image_url, content: row.content });
    } else if (pendingImages.has(msgId)) {
      send(res, 200, { status: "pending", content: row.content });
    } else {
      send(res, 200, { status: "none", content: row.content });
    }
    return;
  }

  // POST /messages/:id/image — 重新生成该消息的图片
  if (method === "POST" && imgPollMatch) {
    const msgId = Number(imgPollMatch[1]);
    if (pendingImages.has(msgId)) { send(res, 200, { ok: true, pending: true }); return; }
    const msg = await dbGet("SELECT id, session_id, content, image_prompt FROM messages WHERE id = ?", [msgId]);
    if (!msg) { send(res, 404, { error: "message not found" }); return; }
    const sessionId = msg.session_id;
    const settings = await getUserSettings(userId);
    const imageFallbackEnabled = settings.imageFallbackEnabled;
    // 清除旧图
    await dbRun("UPDATE messages SET image_url = NULL WHERE id = ?", [msgId]);
    // 用已有 prompt 或重新生成
    let prompt = msg.image_prompt;
    if (!prompt) {
      const recentMsgs = await dbAll("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10", [sessionId]);
      recentMsgs.reverse();
      const previousScene = await getLastImagePrompt(sessionId);
      prompt = await generateImagePrompt("", msg.content, recentMsgs, previousScene, userId);
    }
    pushToSession(sessionId, { image_pending: true, msg_id: msgId });
    fireImageGeneration(msgId, prompt, sessionId, { silent: false, imageFallbackEnabled, userId });
    send(res, 200, { ok: true });
    return;
  }

  // DELETE /messages/:id — 撤回该消息及之后的所有消息（用于重新生成）
  const deleteMsgMatch = pathname.match(/^\/messages\/(\d+)$/);
  if (method === "DELETE" && deleteMsgMatch) {
    const msgId = Number(deleteMsgMatch[1]);
    const msg = await getMessage(msgId);
    if (!msg) {
      send(res, 404, { error: "message not found" });
      return;
    }
    await deleteMessagesFrom(msg.session_id, msgId);
    send(res, 200, { ok: true });
    return;
  }

  // DELETE /messages/:id/single — 只删除这一条消息
  const deleteSingleMatch = pathname.match(/^\/messages\/(\d+)\/single$/);
  if (method === "DELETE" && deleteSingleMatch) {
    const msgId = Number(deleteSingleMatch[1]);
    const msg = await getMessage(msgId);
    if (!msg) {
      send(res, 404, { error: "message not found" });
      return;
    }
    await deleteMessageSingle(msgId);
    send(res, 200, { ok: true });
    return;
  }

  // GET /sessions/:id/events — 已迁移到 WebSocket，保留空路由兼容旧客户端
  const eventsMatch = pathname.match(/^\/sessions\/(\d+)\/events$/);
  if (method === "GET" && eventsMatch) {
    send(res, 410, { error: "SSE events endpoint removed, use WebSocket /ws" });
    return;
  }

  // GET /sessions/:id/mood — 获取当前情绪状态
  const moodMatch = pathname.match(/^\/sessions\/(\d+)\/mood$/);
  if (method === "GET" && moodMatch) {
    const sessionId = Number(moodMatch[1]);
    const session = await getSession(sessionId, userId);
    if (!session) { send(res, 404, { error: "not found" }); return; }
    send(res, 200, { mood: session.mood || "neutral", topic_summary: session.topic_summary || null, dnd_start: session.dnd_start, dnd_end: session.dnd_end, proactive_idle_minutes: session.proactive_idle_minutes || null });
    return;
  }

  // GET /sessions/:id/export — 导出对话为纯文本
  const exportMatch = pathname.match(/^\/sessions\/(\d+)\/export$/);
  if (method === "GET" && exportMatch) {
    const sessionId = Number(exportMatch[1]);
    const session = await getSession(sessionId, userId);
    if (!session) { send(res, 404, { error: "not found" }); return; }
    const msgs = (await getMessages(sessionId)).filter((m) => m.role !== "system" && !m.content.startsWith("（"));
    const exportCharName = await getCharacterName(userId);
    const lines = msgs.map((m) => {
      const who = m.role === "user" ? "你" : exportCharName;
      const time = m.created_at ? new Date(m.created_at).toLocaleString("zh-CN") : "";
      return `[${time}] ${who}：${m.content === "[图片]" ? "[图片]" : m.content}`;
    });
    const text = `# ${session.title}\n\n${lines.join("\n\n")}`;
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="chat-${sessionId}.txt"`,
      "Access-Control-Allow-Origin": "*"
    });
    res.end(text);
    return;
  }

  // GET /gallery — 所有生成图片（分页，按时间倒序）
  if (method === "GET" && pathname === "/gallery") {
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const character = url.searchParams.get("character") || null;
    let rows;
    if (character) {
      rows = await dbAll(
        `SELECT m.id, m.session_id, m.image_url, m.image_prompt, m.created_at, s.title FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.image_url IS NOT NULL AND m.role = 'assistant' AND m.character_name = ? AND s.user_id = ? ORDER BY m.id DESC LIMIT ${limit + 1} OFFSET ${offset}`,
        [character, userId]
      );
    } else {
      rows = await dbAll(
        `SELECT m.id, m.session_id, m.image_url, m.image_prompt, m.created_at, s.title FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.image_url IS NOT NULL AND m.role = 'assistant' AND s.user_id = ? ORDER BY m.id DESC LIMIT ${limit + 1} OFFSET ${offset}`,
        [userId]
      );
    }
    const hasMore = rows.length > limit;
    send(res, 200, { items: rows.slice(0, limit), hasMore });
    return;
  }

  // GET /search?q=... — 全文搜索消息
  if (method === "GET" && pathname === "/search") {
    const q = url.searchParams.get("q") || "";
    if (!q.trim()) { send(res, 200, []); return; }
    const rows = await dbAll(
      "SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.content LIKE ? AND m.role != 'system' AND s.user_id = ? ORDER BY m.id DESC LIMIT 50",
      [`%${q}%`, userId]
    );
    send(res, 200, rows);
    return;
  }

  // PATCH /sessions/:id/settings — 更新防打扰等设置
  const settingsMatch = pathname.match(/^\/sessions\/(\d+)\/settings$/);
  if (method === "PATCH" && settingsMatch) {
    const sessionId = Number(settingsMatch[1]);
    const body = await readBody(req);
    if ("dnd_start" in body) await dbRun("UPDATE sessions SET dnd_start = ? WHERE id = ?", [body.dnd_start || null, sessionId]);
    if ("dnd_end" in body) await dbRun("UPDATE sessions SET dnd_end = ? WHERE id = ?", [body.dnd_end || null, sessionId]);
    if ("proactive_idle_minutes" in body) {
      const mins = body.proactive_idle_minutes ? Number(body.proactive_idle_minutes) : null;
      await dbRun("UPDATE sessions SET proactive_idle_minutes = ? WHERE id = ?", [mins || null, sessionId]);
    }
    if ("auto_mode" in body) {
      await dbRun("UPDATE sessions SET auto_mode = ? WHERE id = ?", [body.auto_mode ? 1 : 0, sessionId]);
    }
    send(res, 200, await getSession(sessionId, userId));
    return;
  }

  // POST /sessions/:id/auto-user-message — 自动模式：生成用户消息并触发角色回复
  const autoUserMatch = pathname.match(/^\/sessions\/(\d+)\/auto-user-message$/);
  if (method === "POST" && autoUserMatch) {
    const sessionId = Number(autoUserMatch[1]);
    const session = await getSession(sessionId, userId);
    if (!session || !session.auto_mode) {
      send(res, 400, { error: "auto mode not enabled" });
      return;
    }
    const text = await generateAutoUserMessage(sessionId);
    if (!text) {
      send(res, 200, { ok: false, reason: "no message generated" });
      return;
    }
    send(res, 200, { ok: true, text });
    return;
  }

  // GET /sessions/:id/reply-suggestions — 半自动模式：生成回复选项
  const suggestMatch = pathname.match(/^\/sessions\/(\d+)\/reply-suggestions$/);
  if (method === "GET" && suggestMatch) {
    const sessionId = Number(suggestMatch[1]);
    const suggestions = await generateReplySuggestions(sessionId);
    send(res, 200, { suggestions });
    return;
  }

  // GET /settings — 全局设置
  if (method === "GET" && pathname === "/settings") {
    send(res, 200, await getUserSettings(userId));
    return;
  }

  // PATCH /settings — 更新全局设置
  if (method === "PATCH" && pathname === "/settings") {
    const body = await readBody(req);
    const patch = {};
    if ("imageFallbackEnabled" in body) patch.imageFallbackEnabled = !!body.imageFallbackEnabled;
    if ("chatImageEnabled" in body) patch.chatImageEnabled = !!body.chatImageEnabled;
    if ("imageAutoExpand" in body) patch.imageAutoExpand = !!body.imageAutoExpand;
    if ("collapseAction" in body) patch.collapseAction = !!body.collapseAction;
    if ("ttsEnabled" in body) patch.ttsEnabled = !!body.ttsEnabled;
    if ("ttsLang" in body) patch.ttsLang = body.ttsLang;
    if ("llmProvider" in body) {
      const user = await dbGet("SELECT is_admin FROM users WHERE id = ?", [userId]);
      if (body.llmProvider === "newapi" && !user?.is_admin) {
        send(res, 403, { error: "only admin can use newapi" });
        return;
      }
      patch.llmProvider = body.llmProvider;
    }
    await saveUserSettings(userId, patch);
    send(res, 200, await getUserSettings(userId));
    return;
  }

  send(res, 404, { error: "not found" });
}

// ── WebSocket 推送 ────────────────────────────────────────────────────────────

// sessionId -> Set<WebSocket>
const sessionClients = new Map();
const userClients = new Map(); // userId -> Set<ws>

function registerClient(sessionId, ws, userId) {
  if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
  sessionClients.get(sessionId).add(ws);
  if (userId) {
    if (!userClients.has(userId)) userClients.set(userId, new Set());
    userClients.get(userId).add(ws);
  }
}

function unregisterClient(sessionId, ws, userId) {
  sessionClients.get(sessionId)?.delete(ws);
  if (userId) userClients.get(userId)?.delete(ws);
}

function pushToSession(sessionId, payload) {
  const clients = sessionClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch {}
    }
  }
}

function pushToUser(userId, payload) {
  const clients = userClients.get(userId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch {}
    }
  }
}

// 每 2 分钟检查一次，超过配置时长没有用户消息则主动发起
const PROACTIVE_IDLE_MS = PROACTIVE_IDLE_MINUTES * 60 * 1000;
const PROACTIVE_CHECK_MS = 2 * 60 * 1000;

setInterval(async () => {
  const sessions = await listAllActiveSessions();
  const now = Date.now();
  const nowHHMM = new Date().toTimeString().slice(0, 5); // "HH:MM"
  for (const session of sessions) {
    if (!session.last_user_at) continue;
    const idleMs = now - new Date(session.last_user_at).getTime();
    const sessionIdleMs = session.proactive_idle_minutes
      ? session.proactive_idle_minutes * 60 * 1000
      : PROACTIVE_IDLE_MS;
    if (idleMs < sessionIdleMs) continue;
    // 用户没有在上次主动消息之后回复过，不再重复发
    if (session.last_proactive_at && session.last_user_at <= session.last_proactive_at) continue;
    // 勿扰时段检查
    if (session.dnd_start && session.dnd_end) {
      const inDnd = session.dnd_start <= session.dnd_end
        ? nowHHMM >= session.dnd_start && nowHHMM < session.dnd_end
        : nowHHMM >= session.dnd_start || nowHHMM < session.dnd_end;
      if (inDnd) continue;
    }
    // 只推给有活跃连接的 session
    const clients = sessionClients.get(session.id);
    if (!clients || clients.size === 0) continue;
    console.log(`主动发消息 [session ${session.id}]，已空闲 ${Math.round(idleMs / 60000)} 分钟`);
    // 记录本次主动发消息时间，防止用户未回复时重复触发
    await dbRun("UPDATE sessions SET last_proactive_at = ? WHERE id = ?", [nowIso(), session.id]);
    const sessionUserId = session.user_id ?? null;
    const text = await generateProactiveMessage(session.id, sessionUserId).catch(() => null);
    if (!text) continue;
    const { cleanText, prompt: imgPrompt } = extractImageTag(text);
    const msgId = await appendMessage(session.id, "assistant", cleanText, await getCharacterName(sessionUserId), sessionUserId);
    const payload = { proactive: true, msg_id: Number(msgId), text: cleanText };
    if (imgPrompt) {
      const previousScene = await getLastImagePrompt(session.id);
      if (await consumeDailyImageQuota(sessionUserId)) {
        payload.image_pending = true;
        fireImageGeneration(Number(msgId), imgPrompt, session.id, { silent: true, previousScene, userId: sessionUserId });
      } else {
        console.log(`[主动插图] 用户 ${sessionUserId} 今日配额已用完，跳过`);
      }
    }
    pushToSession(session.id, payload);
    const updatedMsgs = await getMessages(session.id);
    updateMood(session.id, updatedMsgs, sessionUserId).catch(() => {});
  }

  // ── 日记生成：空闲 > 2 小时且未生成过日记的 session ──
  const DIARY_IDLE_MS = 2 * 60 * 60 * 1000;
  const allSessions = await listAllActiveSessions();
  for (const session of allSessions) {
    if (!session.last_user_at || session.diary_generated) continue;
    const idleMs = Date.now() - new Date(session.last_user_at).getTime();
    if (idleMs < DIARY_IDLE_MS) continue;
    const sessionUserId = session.user_id ?? null;
    if (!sessionUserId) continue;
    const msgs = await getMessages(session.id);
    if (msgs.filter(m => m.role === "user").length < 4) continue;
    const char = await getActiveCharacter(sessionUserId);
    if (!char) continue;
    const charName = char.name || "default";
    console.log(`[diary] 生成日记 session=${session.id} user=${sessionUserId} char=${charName}`);
    const diary = await generateDiary(session.id, sessionUserId).catch(() => null);
    if (!diary) continue;
    await dbRun(
      "INSERT INTO character_diaries (user_id, character_id, session_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
      [sessionUserId, char.id, session.id, diary, nowIso()]
    );
    await dbRun("UPDATE sessions SET diary_generated = 1 WHERE id = ?", [session.id]);
    ingestToMemory(`[${charName}的内心独白] ${diary}`, charName, sessionUserId);
    console.log(`[diary] 日记已生成并存储: ${diary.slice(0, 50)}...`);
  }
}, PROACTIVE_CHECK_MS);

// ── 角色来电检测（每 1 分钟，按当前活跃 session 维度）────────────────────────
setInterval(async () => {
  const now = Date.now();
  const nowHHMM = new Date().toTimeString().slice(0, 5);
  const callMinMessages = Number(await getGlobalSetting("call_min_messages", "20"));
  const callIdleMinutes = Number(await getGlobalSetting("call_idle_minutes", "5"));
  const callIdleMs = callIdleMinutes * 60 * 1000;
  const callCooldownMs = Number(await getGlobalSetting("call_cooldown_minutes", "60")) * 60 * 1000;
  const today = new Date().toISOString().slice(0, 10);

  // 只处理有活跃 WS 连接的 session
  const activeSessionIds = [...sessionClients.entries()]
    .filter(([, set]) => set.size > 0)
    .map(([sid]) => Number(sid));
  console.log(`[来电检测] activeSessionIds=${JSON.stringify(activeSessionIds)}`);
  if (activeSessionIds.length === 0) return;

  for (const sessionId of activeSessionIds) {
    const session = await getSession(sessionId);
    if (!session || session.archived) continue;
    const userId = session.user_id;
    if (!userId) continue;

    // 勿扰时段
    if (session.dnd_start && session.dnd_end) {
      const { dnd_start, dnd_end } = session;
      const inDnd = dnd_start <= dnd_end
        ? nowHHMM >= dnd_start && nowHHMM < dnd_end
        : nowHHMM >= dnd_start || nowHHMM < dnd_end;
      if (inDnd) continue;
    }

    // 该 session 对应的角色（取最后一条 assistant 消息的 character_name）
    const lastAssistantMsg = await dbGet(
      "SELECT character_name FROM messages WHERE session_id = ? AND role = 'assistant' AND character_name IS NOT NULL ORDER BY id DESC LIMIT 1",
      [sessionId]
    );
    if (!lastAssistantMsg?.character_name) continue;
    const char = await dbGet("SELECT * FROM characters WHERE name = ? AND user_id = ?", [lastAssistantMsg.character_name, userId]);
    if (!char) continue;

    // 最近一条用户消息时间
    const lastUserMsg = await dbGet(
      "SELECT MAX(created_at) as last_user_at FROM messages WHERE session_id = ? AND role = 'user'",
      [sessionId]
    );
    const lastUserAt = lastUserMsg?.last_user_at;
    if (!lastUserAt) { console.log(`[来电跳过] session=${sessionId} 无用户消息`); continue; }

    const idleMs = now - new Date(lastUserAt).getTime();
    if (idleMs < callIdleMs) { console.log(`[来电跳过] session=${sessionId} char=${char.name} 空闲不足 ${Math.round(idleMs/60000)}/${callIdleMinutes}分钟`); continue; }

    // 冷却期
    if (session.last_call_at && (now - new Date(session.last_call_at).getTime()) < callCooldownMs) { console.log(`[来电跳过] session=${sessionId} char=${char.name} 冷却中 last_call_at=${toLocal(session.last_call_at)}`); continue; }

    // 今日该角色对话中的用户消息数
    const todayMsgs = await dbGet(`
      SELECT COUNT(*) as n FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE s.user_id = ? AND m.role = 'user' AND m.created_at LIKE ?
        AND EXISTS (SELECT 1 FROM messages WHERE session_id = m.session_id AND role = 'assistant' AND character_name = ?)
    `, [userId, `${today}%`, char.name]);
    if ((todayMsgs?.n || 0) < callMinMessages) { console.log(`[来电跳过] session=${sessionId} char=${char.name} 今日消息数不足 ${todayMsgs?.n}/${callMinMessages}`); continue; }

      console.log(`[来电] user=${userId} char=${char.name} session=${session.id} reason=空闲 今日消息=${todayMsgs.n} 空闲=${Math.round(idleMs / 60000)}分钟 tts=${char.tts_enabled ? "on" : "off"}`);
      await dbRun("UPDATE sessions SET last_call_at = ? WHERE id = ?", [nowIso(), session.id]);

      const script = await generateCallScript(session.id, userId).catch(() => null);
      if (!script) continue;

      let audioUrl = null;
      const ttsSettings = await getUserSettings(userId);
      const lang = ttsSettings.ttsLang || "zh";

      if (char.voice_id && char.tts_enabled) {
        try {
          const ttsScript = script
            .replace(/[（(][^）)]{0,80}[）)]/g, "")
            .replace(/[【\[][^\]】]{0,80}[\]】]/g, "")
            .replace(/\*[^*]{0,80}\*/g, "")
            .replace(/\s{2,}/g, " ").trim();
          let ttsInput = ttsScript;
          if (lang === "ja") ttsInput = await translateToJapanese(ttsScript);
          const ch = char.voice_channel || "qwen";
          const synthFn = ch === "cosyvoice" ? synthesizeSpeechCosyVoice : ch === "qwen-omni" ? synthesizeSpeechQwenOmni : synthesizeSpeech;
          const { url } = await synthFn(ttsInput, char.voice_id, lang, "带电话音效果，语气有点生气，带着一丝委屈");
          audioUrl = url;
        } catch (err) {
          console.error("[来电] TTS 合成失败:", err.message);
        }
      }

      const callLogResult = await dbRun(
        "INSERT INTO call_logs (user_id, session_id, char_name, script, audio_url, answered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
        [userId, session.id, char.name, script, audioUrl || null, nowIso()]
      );
      const callLogId = callLogResult.insertId;

      // 写入对话记录（标识为来电）
      const callMsgId = await appendMessage(session.id, "assistant", `📞 [未接听] ${script}`, char.name, userId);
      if (audioUrl) await dbRun("UPDATE messages SET tts_audio_url = ? WHERE id = ?", [audioUrl, callMsgId]);
      await dbRun("UPDATE call_logs SET msg_id = ? WHERE id = ?", [callMsgId, callLogId]);

      pushToUser(userId, {
        incoming_call: true,
        call_log_id: callLogId,
        msg_id: callMsgId,
        session_id: session.id,
        char_name: char.name,
        script,
        audio_url: audioUrl,
        tts_lang: lang
      });
  }

  // 节日来电检查（每年每节日触发一次，对所有在线用户）
  const HOLIDAYS = { "02-14": "情人节", "05-20": "520", "07-07": "七夕", "12-25": "圣诞节", "01-01": "元旦" };
  const todayMMDD = today.slice(5);
  if (HOLIDAYS[todayMMDD]) {
    const holidayKey = `holiday_call_${today.slice(0, 4)}_${todayMMDD}`;
    if (await getGlobalSetting(holidayKey, "0") === "0") {
      await setGlobalSetting(holidayKey, "1");
      const activeUids = [...userClients.entries()].filter(([, set]) => set.size > 0).map(([uid]) => uid);
      console.log(`[节日来电] 触发 ${HOLIDAYS[todayMMDD]}（${todayMMDD}），在线用户数=${activeUids.length}`);
      for (const uid of activeUids) {
        const s = await dbGet("SELECT id FROM sessions WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1", [uid]);
        if (s) triggerSpecialCall(s.id, uid, `holiday_${todayMMDD}`, HOLIDAYS[todayMMDD]).catch((e) => console.error("[节日来电] 失败:", e.message));
      }
    }
  }
}, 60 * 1000);

// ── 启动 ──────────────────────────────────────────────────────────────────────

if (!OPENAI_API_KEY) {
  console.error("请设置 OPENAI_API_KEY");
  process.exit(1);
}

getDb();
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(err);
    send(res, 500, { error: err.message });
  });
});

// ── WebSocket 服务器（附加到同一 HTTP server）────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  // 从 URL query 取 sessionId 与可选 token（RN 端走 query token，Web 端走 cookie）
  // sessionId 可为 0：表示全局监听（接收当前用户所有 session 的事件，用于本地通知）
  const url = new URL(req.url, `http://localhost`);
  const sessionId = Number(url.searchParams.get("sessionId"));
  if (sessionId === null || Number.isNaN(sessionId)) { ws.close(4001, "missing sessionId"); return; }

  let token = url.searchParams.get("token");
  if (!token) {
    const cookieHeader = req.headers.cookie || "";
    const m = cookieHeader.match(/(?:^|;\s*)sid=([^;]+)/);
    token = m ? m[1] : null;
  }
  const authSession = token ? await loadAuthSession(token) : null;
  const userId = authSession?.userId ?? null;

  registerClient(sessionId, ws, userId);
  console.log(`[ws] 连接 session=${sessionId} user=${userId}`);

  // 连接建立后立即下发未通知的成就
  if (userId) {
    try {
      const char = await getActiveCharacter(userId);
      if (char) {
        const pending = await dbAll(
          `SELECT ua.id, ua.selfie_url, ua.inner_voice,
                  a.id as achievement_id, a.name, a.type, a.threshold
           FROM user_achievements ua
           JOIN achievements a ON a.id = ua.achievement_id
           WHERE ua.user_id = ? AND ua.character_id = ? AND ua.notified = 0 AND ua.selfie_url IS NOT NULL`,
          [userId, char.id]
        );
        for (const row of pending) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              achievement_unlock: true,
              achievement: { id: row.achievement_id, name: row.name, type: row.type, threshold: row.threshold },
              selfie_url: row.selfie_url,
              inner_voice: row.inner_voice,
              ua_id: row.id
            }));
          }
        }

        // 补推未通知的关系里程碑
        const pendingMilestones = await dbAll(
          "SELECT * FROM relationship_milestones WHERE user_id = ? AND character_id = ? AND notified = 0 AND (comic_url_1 IS NOT NULL OR video_url IS NOT NULL)",
          [userId, char.id]
        );
        for (const row of pendingMilestones) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              relation_milestone: true,
              milestone_id: row.id,
              stage: row.stage,
              stage_name: row.stage_name,
              affection: row.affection,
              comic_url_1: row.comic_url_1,
              comic_url_2: row.comic_url_2,
              video_url: row.video_url,
            }));
          }
        }
      }
    } catch {}
  }

  ws.on("close", () => {
    unregisterClient(sessionId, ws, userId);
    console.log(`[ws] 断开 session=${sessionId}`);
  });

  ws.on("error", () => unregisterClient(sessionId, ws, userId));
});

// ping/pong keepalive，每 25 秒检测一次
setInterval(() => {
  for (const [, clients] of sessionClients) {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      } else {
        // 清理已关闭的连接
        clients.delete(ws);
      }
    }
  }
}, 25000);

// 启动时确保 characters 表有激活角色（从 soul.md 初始化）
const DEFAULT_CHARACTER = {
  name: "龙卷",
  appearance: "绿色长卷发，娇小纤细身材，白色连衣裙，气质高冷，动漫少女，精致五官，大眼睛，《一拳超人》动漫的地狱龙卷",
  personality: "龙卷表面上傲娇、嘴硬，但内心其实很顺从，容易害羞",
  description: "《一拳超人》动漫中的地狱龙卷",
};

async function ensureDefaultCharacter(userId) {
  let countRow;
  if (userId != null) {
    countRow = await dbGet("SELECT COUNT(*) as n FROM characters WHERE user_id = ?", [userId]);
  } else {
    countRow = await dbGet("SELECT COUNT(*) as n FROM characters WHERE user_id IS NULL", []);
  }
  if (countRow.n > 0) return;

  const fileSoul = loadSoulFromFile();
  let name, appearance, personality, description, remainingSoul;
  if (fileSoul && extractSectionFromSoul(fileSoul, "# 角色名称")) {
    name = extractSectionFromSoul(fileSoul, "# 角色名称");
    appearance = extractSectionFromSoul(fileSoul, "# 外貌") || "";
    personality = extractSectionFromSoul(fileSoul, "# 性格") || "";
    description = extractSectionFromSoul(fileSoul, "# 人物说明") || "";
    remainingSoul = removeSections(fileSoul, ["# 角色名称", "# 外貌", "# 性格", "# 人物说明"]);
  } else {
    name = DEFAULT_CHARACTER.name;
    appearance = DEFAULT_CHARACTER.appearance;
    personality = DEFAULT_CHARACTER.personality;
    description = DEFAULT_CHARACTER.description;
    remainingSoul = fileSoul || "";
  }

  await dbRun(
    "INSERT IGNORE INTO characters (name, appearance, personality, description, soul_content, is_active, created_at, user_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    [name, appearance, personality, description, remainingSoul, nowIso(), userId ?? null]
  );
  console.log(`已初始化默认角色：${name}`);
}

function removeSections(soul, headers) {
  const lines = soul.split("\n");
  const result = [];
  let skip = false;
  for (const line of lines) {
    if (headers.includes(line.trim())) { skip = true; continue; }
    if (skip && line.startsWith("#")) skip = false;
    if (!skip) result.push(line);
  }
  return result.join("\n").trim();
}

// ── 成就系统 ──────────────────────────────────────────────────────────────────

async function getAchievementStage(userId, charId) {
  try {
    const rows = await dbAll(
      `SELECT a.type, a.threshold FROM user_achievements ua
       JOIN achievements a ON a.id = ua.achievement_id
       WHERE ua.user_id = ? AND ua.character_id = ?`,
      [userId, charId]
    );
    if (!rows.length) return 0;
    // 最高成就决定阶段：affection≥90 / message_count≥1000 / streak≥30 → 3
    // affection≥60 / message_count≥500 / streak≥7 → 2
    // 任意一个成就 → 1
    const has = (type, threshold) => rows.some(r => r.type === type && r.threshold >= threshold);
    if (has("affection", 90) || has("message_count", 1000) || has("streak_days", 30)) return 3;
    if (has("affection", 60) || has("message_count", 500) || has("streak_days", 7)) return 2;
    return 1;
  } catch {
    return 0;
  }
}

const DEFAULT_ACHIEVEMENTS = [
  { type: "message_count", threshold: 100,  name: "百条留言" },
  { type: "message_count", threshold: 500,  name: "五百条留言" },
  { type: "message_count", threshold: 1000, name: "千条留言" },
  { type: "affection",     threshold: 30,   name: "初生好感" },
  { type: "affection",     threshold: 60,   name: "心动加速" },
  { type: "affection",     threshold: 90,   name: "深深爱意" },
  { type: "streak_days",   threshold: 3,    name: "三日相伴" },
  { type: "streak_days",   threshold: 7,    name: "七日之约" },
  { type: "streak_days",   threshold: 30,   name: "一月相守" },
];

async function seedDefaultAchievements() {
  const row = await dbGet("SELECT COUNT(*) as n FROM achievements", []);
  if (row.n > 0) return;
  for (const a of DEFAULT_ACHIEVEMENTS) {
    await dbRun("INSERT INTO achievements (type, threshold, name, enabled, created_at) VALUES (?, ?, ?, 1, ?)", [a.type, a.threshold, a.name, nowIso()]);
  }
  console.log("[achievements] 已初始化默认成就");
}

async function updateStreakDays(userId) {
  const char = await getActiveCharacter(userId);
  if (!char) return;
  const today = new Date().toISOString().slice(0, 10);
  if (char.last_chat_date === today) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newStreak = char.last_chat_date === yesterday ? (char.streak_days || 0) + 1 : 1;
  await dbRun("UPDATE characters SET streak_days = ?, last_chat_date = ? WHERE id = ?", [newStreak, today, char.id]);
  // streak 里程碑触发特殊来电
  if ([3, 7, 14, 30].includes(newStreak)) {
    console.log(`[streak来电] user=${userId} char=${char.name} streak=${newStreak}天`);
    const s = await dbGet("SELECT id FROM sessions WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1", [userId]);
    if (s) triggerSpecialCall(s.id, userId, "streak", newStreak).catch((e) => console.error("[特殊来电] streak 触发失败:", e.message));
  }
}

async function generateAchievementInnerVoice(charName, affection, achievementName, personality, recentContext) {
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content: `你是${charName}。${personality ? `性格：${personality}。` : ""}请用第一人称写一段心理独白，表达解锁成就"${achievementName}"时的内心感受。当前心动值 ${affection}/100。50字以内，不要加引号，直接输出独白内容。`
        },
        {
          role: "user",
          content: `最近的对话记录：\n${recentContext}\n\n写出你此刻的心理独白。`
        }
      ]
    });
    return res.choices?.[0]?.message?.content?.trim() || "";
  } catch {
    return "";
  }
}

async function generateAchievementSelfie(userId, achievementName, achType, achThreshold, personality, description, recentContext, plotSummary, { imageFallbackEnabled = true } = {}) {
  const appearance = (await getCharacterAppearance(userId)).slice(0, 200);

  const typeHint = {
    message_count: "与聊天、手机、文字相关的日常场景",
    affection:     "与情感、心动、甜蜜相关的温柔场景",
    streak_days:   "与日常坚持、时间流逝、陪伴相关的生活场景",
  }[achType] || "自然生活场景";

  const personalityHint = personality ? `角色性格：${personality}。` : "";
  const descriptionHint = description ? `角色背景：${description}。` : "";
  const plotHint = plotSummary ? `当前剧情：${plotSummary}。` : "";

  const sceneRes = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    max_tokens: 120,
    messages: [
      {
        role: "system",
        content: `你是一个图片描述生成助手。根据成就信息和最近对话，为角色生成一段自然生活照或自拍的场景描述，用于生成图片。
${personalityHint}${descriptionHint}${plotHint}
要求：
- 场景要与成就"${achievementName}"（类型：${typeHint}）在情感上匹配，并结合当前剧情氛围
- 自然真实，像生活照或随手自拍，不要摆拍感
- 只描述场景、动作、氛围、光线，不要描述外貌
- 60字以内，中文，直接输出描述，不加任何前缀`
      },
      {
        role: "user",
        content: `最近的对话记录：\n${recentContext}\n\n生成场景描述。`
      }
    ]
  });
  const sceneDesc = (sceneRes.choices?.[0]?.message?.content || "").trim() || "自然光线下，轻松自拍";
  const prompt = `${appearance}，${sceneDesc}，动漫风格，精致五官，高质量，自然真实感`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callImageApi(prompt, { aspectRatio: "1:1" });
    } catch (err) {
      console.error(`[achievements] 成就生图第 ${attempt} 次失败:`, err.message);
      if (attempt === 3) break;
    }
  }

  // 3 次失败后走 fallback
  if (!imageFallbackEnabled) return null;
  try {
    const fallbackPrompt = `${appearance}，自拍，自然光，动漫风格，高质量`;
    return await callImageApiFallback(fallbackPrompt, { aspectRatio: "1:1" });
  } catch {
    return null;
  }
}

// ── 关系阶段升级 ──────────────────────────────────────────────────────────────

const RELATION_STAGES = [
  { stage: 1, name: "初识", min: 0  },
  { stage: 2, name: "相知", min: 30 },
  { stage: 3, name: "羁绊", min: 60 },
  { stage: 4, name: "挚爱", min: 90 },
];

function getRelationStage(affection) {
  let current = RELATION_STAGES[0];
  for (const s of RELATION_STAGES) {
    if (affection >= s.min) current = s;
  }
  return current;
}

async function cloneVoiceCosyVoice(audioUrl, charId) {
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: "cosyvoice-v3.5-plus",
        prefix: `char${charId}`,
        url: audioUrl,
        language_hints: ["zh"],
        max_prompt_audio_length: 20.0,
        enable_preprocess: true
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CosyVoice clone ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const voiceId = data.output?.voice_id;
  if (!voiceId) throw new Error(`CosyVoice clone: no voice_id in response`);
  return voiceId;
}

async function deleteVoiceCosyVoice(voiceId) {
  await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "voice-enrollment", input: { action: "delete_voice", voice_id: voiceId } })
  });
}

async function synthesizeSpeechCosyVoice(text, voiceId, lang = "zh", instruction = "", onChunk = null) {
  const taskId = crypto.randomUUID();
  const allChunks = [];

  await new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://dashscope.aliyuncs.com/api-ws/v1/inference", {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });
    let settled = false;
    const finish = (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => { ws.terminate(); finish(new Error("CosyVoice TTS timeout")); }, 60000);

    ws.on("open", () => {
      const parameters = { text_type: "PlainText", voice: voiceId, format: "pcm", sample_rate: 24000, volume: 50, rate: 1.0, pitch: 1.0 };
      if (instruction) parameters.instruction = instruction;
      if (lang !== "zh") parameters.language_hints = [lang];
      ws.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: "cosyvoice-v3.5-plus", parameters, input: {} }
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const chunk = Buffer.from(data);
        allChunks.push(chunk);
        if (onChunk) onChunk(chunk);
        return;
      }
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      const event = msg.header?.event;
      if (event === "task-started") {
        ws.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text } } }));
        ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
      } else if (event === "task-finished") {
        ws.close(); finish(null);
      } else if (event === "task-failed") {
        finish(new Error(`CosyVoice TTS failed: ${msg.header?.error_message || JSON.stringify(msg)}`));
      }
    });
    ws.on("error", (err) => finish(err));
    ws.on("close", () => finish(null));
  });

  const pcm = Buffer.concat(allChunks);
  const wav = pcm16ToWav(pcm, 24000, 1, 16);
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${lang}.wav`;
  const url = await uploadToOss(wav, filename);
  return { url, durationMs: 0 };
}

function pcm16ToWav(pcmBuf, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const dataSize = pcmBuf.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuf]);
}

async function cloneVoice(audioUrl, charId) {
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-voice-enrollment",
      input: {
        action: "create",
        target_model: "qwen3-tts-vc-realtime-2026-01-15",
        preferred_name: `char${charId}`,
        audio: { data: audioUrl }
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QwenTTS clone ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const voice = data.output?.voice;
  if (!voice) throw new Error(`QwenTTS clone: no voice in response. ${JSON.stringify(data).slice(0, 200)}`);
  return voice;
}

async function deleteVoice(voiceId) {
  await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen-voice-enrollment", input: { action: "delete", voice: voiceId } })
  });
}

async function summarizePlot(msgs) {
  if (!msgs || msgs.length === 0) return "";
  const context = msgs.map((m) => `${m.role === "user" ? "用户" : "角色"}：${m.content.slice(0, 120)}`).join("\n");
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content: "你是剧情总结助手。根据对话记录，用100字以内总结当前两人之间发生的主要剧情、情感走向和关键事件，直接输出总结，不加任何前缀。"
      },
      { role: "user", content: context }
    ]
  });
  return (res.choices?.[0]?.message?.content || "").trim().slice(0, 150);
}

async function generateTtsInstruction(charName, personality, mood, recentMsgs) {
  const context = recentMsgs.slice(-4).map((m) => `${m.role === "user" ? "用户" : charName}: ${m.content.slice(0, 60)}`).join("\n");
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    messages: [
      {
        role: "system",
        content: "你是语音合成指令生成助手。根据角色信息和当前对话情绪，生成一段简短的语音合成风格指令（不超过50字），只描述语速、语调、情感状态等朗读风格，不得包含任何台词、对话内容或引号内的文字，直接输出指令，不要任何解释。示例：语速稍快，语气不耐烦，带轻微鼻音。"
      },
      {
        role: "user",
        content: `角色名：${charName}\n性格：${(personality || "").slice(0, 100)}\n当前情绪：${mood || "平静"}\n近期对话：\n${context}`
      }
    ]
  });
  return (res.choices?.[0]?.message?.content || "").trim().slice(0, 50);
}

async function translateToJapanese(text) {
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    messages: [
      { role: "system", content: "你是翻译助手。将用户输入的中文翻译成自然流畅的日语，只输出日语译文，不要任何解释。" },
      { role: "user", content: text }
    ]
  });
  return (res.choices?.[0]?.message?.content || text).trim();
}

async function synthesizeSpeech(text, voiceId, lang = "zh", instruction = "") {
  const langType = lang === "ja" ? "Japanese" : "Chinese";
  const input = { text, voice: voiceId, language_type: langType };
  const parameters = {};
  if (instruction) { parameters.instructions = instruction; parameters.optimize_instructions = false; }
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-tts-vc-realtime-2026-01-15", input, parameters })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QwenTTS ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const tempUrl = data.output?.audio?.url || data.output?.choices?.[0]?.message?.content?.[0]?.audio?.url;
  if (!tempUrl) throw new Error(`QwenTTS: no audio url. ${JSON.stringify(data).slice(0, 200)}`);
  const dlRes = await fetch(tempUrl);
  if (!dlRes.ok) throw new Error(`QwenTTS 音频下载失败: ${dlRes.status}`);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${lang}.wav`;
  const url = await uploadToOss(buf, filename);
  return { url, durationMs: 0 };
}

async function cloneVoiceQwenOmni(audioUrl, charId) {
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-voice-enrollment",
      input: {
        action: "create",
        target_model: "qwen3.5-omni-plus-realtime",
        preferred_name: `char${charId}`,
        audio: { data: audioUrl }
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QwenOmni clone ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const voice = data.output?.voice;
  if (!voice) throw new Error(`QwenOmni clone: no voice in response. ${JSON.stringify(data).slice(0, 200)}`);
  return voice;
}

async function deleteVoiceQwenOmni(voiceId) {
  await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen-voice-enrollment", input: { action: "delete", voice: voiceId } })
  });
}

async function synthesizeSpeechQwenOmni(text, voiceId, lang = "zh", instruction = "") {
  const audioChunks = await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime",
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const chunks = [];
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => { ws.terminate(); finish(new Error("QwenOmni TTS timeout")); }, 60000);
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "session.created") {
        ws.send(JSON.stringify({ type: "session.update", session: { voice: voiceId, output_audio_format: "pcm16" } }));
      } else if (msg.type === "session.updated") {
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
      } else if (msg.type === "response.audio.delta") {
        chunks.push(Buffer.from(msg.delta, "base64"));
      } else if (msg.type === "response.done") {
        ws.close();
        finish(null, chunks);
      } else if (msg.type === "error") {
        finish(new Error(`QwenOmni TTS error: ${msg.error?.message || JSON.stringify(msg)}`));
      }
    });
    ws.on("error", (err) => finish(err));
    ws.on("close", () => finish(chunks.length ? null : new Error("QwenOmni TTS: no audio received"), chunks));
  });
  const pcm = Buffer.concat(audioChunks);
  const wav = pcm16ToWav(pcm, 24000, 1, 16);
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${lang}.wav`;
  const url = await uploadToOss(wav, filename, "audio/wav");
  return { url, durationMs: 0 };
}

async function generateRelationVideo(imageUrl, stageName, duration = 3) {
  const prompt = `结合图片场景，让人物自然地动起来，超高帧数，流畅真实`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);
  try {
    const submitRes = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model: "happyhorse-1.0-i2v",
        input: {
          prompt,
          media: [{ type: "first_frame", url: imageUrl }]
        },
        parameters: { resolution: "720P", duration, watermark: false }
      }),
      signal: controller.signal
    });
    if (!submitRes.ok) {
      const errBody = await submitRes.text().catch(() => "");
      throw new Error(`DashScope video submit ${submitRes.status}: ${errBody.slice(0, 200)}`);
    }
    const submitData = await submitRes.json();
    const taskId = submitData.output?.task_id;
    if (!taskId) throw new Error("DashScope video: no task_id");
    console.log(`[milestone] 视频任务已提交 taskId=${taskId}`);
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 30000));
      const pollRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
      });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json();
      const status = pollData.output?.task_status;
      if (status === "SUCCEEDED") {
        const tempUrl = pollData.output?.video_url;
        if (!tempUrl) throw new Error("DashScope video: no video_url in result");
        // 下载并上传到 OSS，避免临时链接过期
        const dlRes = await fetch(tempUrl);
        if (!dlRes.ok) throw new Error(`下载视频失败: ${dlRes.status}`);
        const buf = Buffer.from(await dlRes.arrayBuffer());
        const filename = `milestone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
        const ossUrl = await uploadToOss(buf, filename);
        console.log(`[milestone] 视频已上传 OSS: ${ossUrl}`);
        return ossUrl;
      }
      if (status === "FAILED") throw new Error(`DashScope video task failed: ${JSON.stringify(pollData.output).slice(0, 200)}`);
    }
    throw new Error("DashScope video: task timed out");
  } finally {
    clearTimeout(timeout);
  }
}

async function generateRelationComic(charName, stageName, affection, personality, description, recentContext, plotSummary, { imageFallbackEnabled = true } = {}) {
  const appearance = (await getCharacterAppearance(null)).slice(0, 200);
  const personalityHint = personality ? `角色性格：${personality}。` : "";
  const descHint = description ? `角色背景：${description}。` : "";
  const plotHint = plotSummary ? `当前剧情：${plotSummary}。` : "";

  const scriptRes = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: `你是一个漫画分镜脚本生成助手。根据角色信息和最近对话，为"关系升级到${stageName}"这一时刻生成两组漫画分镜描述。
${personalityHint}${descHint}${plotHint}
要求：
- 每组描述6格连续分镜，格与格之间有时间/情绪递进
- 第一组：回顾与角色相处的6个温馨瞬间，从初见到熟悉，结合当前剧情中的真实场景
- 第二组：关系升级这一刻的情感爆发，共6格，情绪层层递进到高潮
- 画面中只出现该角色一人，不出现其他任何人物
- 每格描述场景、动作、光线、氛围，不描述外貌，40字以内
- 输出严格 JSON：{"comic1": ["格1","格2","格3","格4","格5","格6"], "comic2": ["格1","格2","格3","格4","格5","格6"]}`
      },
      { role: "user", content: `最近对话：\n${recentContext}\n\n当前心动值：${affection}，关系阶段：${stageName}` }
    ]
  });

  let comic1 = [], comic2 = [];
  try {
    let raw = (scriptRes.choices?.[0]?.message?.content || "").trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(raw);
    comic1 = parsed.comic1 || [];
    comic2 = parsed.comic2 || [];
  } catch {
    comic1 = ["清晨阳光洒落，角色独自微笑", "窗边发呆，思绪飘远", "翻看旧物，嘴角上扬", "夜灯下静静等待", "雨天望窗，心情复杂", "终于鼓起勇气，眼神坚定"];
    comic2 = ["心跳加速，光晕弥漫", "深吸一口气，闭上眼睛", "情感涌上心头", "泪光闪烁，却在微笑", "抬起头，眼神明亮", "新的阶段，新的开始"];
  }

  // 确保每组恰好 6 格
  while (comic1.length < 6) comic1.push("温馨瞬间");
  while (comic2.length < 6) comic2.push("情感升华");
  comic1 = comic1.slice(0, 6);
  comic2 = comic2.slice(0, 6);

  const makePrompt = (frames) => {
    const panels = frames.map((f, i) => `第${i + 1}格：${f}`).join("；");
    return `${appearance}，六格漫画，2行3列网格排列，从左到右从上到下依次是：${panels}。画面中只有该角色一人，不出现其他人物。动漫风格，精致画面，电影感光线，高质量`;
  };

  const tryGenImage = async (prompt) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await callImageApi(prompt, { aspectRatio: "16:9" });
      } catch (err) {
        console.error(`[milestone] 漫画生图第 ${attempt} 次失败: ${err.message}`);
        if (attempt === 3) {
          if (!imageFallbackEnabled) return null;
          try {
            return await callImageApiFallback(prompt, { aspectRatio: "16:9" });
          } catch {
            return null;
          }
        }
      }
    }
  };

  const [url1, url2] = await Promise.all([
    tryGenImage(makePrompt(comic1)),
    tryGenImage(makePrompt(comic2)),
  ]);

  return { url1, url2 };
}

async function checkRelationshipMilestone(userId, sessionId, oldAffection, newAffection, { imageFallbackEnabled = true } = {}) {
  const oldStage = getRelationStage(oldAffection);
  const newStage = getRelationStage(newAffection);
  if (newStage.stage <= oldStage.stage) return;

  const char = await getActiveCharacter(userId);
  if (!char) return;

  // INSERT IGNORE 防重复
  let insertResult;
  try {
    insertResult = await dbRun(
      "INSERT IGNORE INTO relationship_milestones (user_id, character_id, stage, stage_name, affection, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, char.id, newStage.stage, newStage.name, newAffection, nowIso()]
    );
  } catch { return; }
  if (!insertResult || insertResult.affectedRows === 0) return;

  const milestoneId = insertResult.insertId;
  console.log(`[milestone] 用户 ${userId} 关系升级：${oldStage.name} → ${newStage.name}`);

  // 异步生成漫画或视频
  (async () => {
    let recentContext = "";
    let plotSummary = "";
    if (sessionId) {
      const msgs = await dbAll(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 50",
        [sessionId]
      );
      msgs.reverse();
      recentContext = msgs.slice(-5).map(m => `${m.role === "user" ? "用户" : "角色"}：${m.content.slice(0, 100)}`).join("\n");
      plotSummary = await summarizePlot(msgs).catch(() => "");
    }

    const milestoneMode = await getGlobalSetting("milestone_mode", "comic");
    const videoDuration = Number(await getGlobalSetting("milestone_video_duration", "3"));

    if (milestoneMode === "video") {
      let videoUrl = null;
      try {
        const appearance = (await getCharacterAppearance(null)).slice(0, 150);
        const personalityHint = char.personality ? `${char.personality.slice(0, 50)}，` : "";
        const descHint = char.description ? `${char.description.slice(0, 50)}，` : "";
        const imgPrompt = `${appearance}，${personalityHint}${descHint}${plotSummary ? `剧情背景：${plotSummary.slice(0, 60)}，` : ""}关系升级到"${newStage.name}"的情感高潮瞬间，只有该角色一人，动漫风格，电影感光线`;
        console.log(`[milestone] 首帧 prompt 长度=${imgPrompt.length}`);
        let frameUrl = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            frameUrl = await callImageApi(imgPrompt, { aspectRatio: "16:9" });
            break;
          } catch (err) {
            console.error(`[milestone] 视频首帧生图第 ${attempt} 次失败: ${err.message}`);
          }
        }
        if (frameUrl) {
          videoUrl = await generateRelationVideo(frameUrl, newStage.name, videoDuration);
        }
      } catch (err) {
        console.error(`[milestone] 视频生成失败:`, err.message);
      }
      await dbRun("UPDATE relationship_milestones SET video_url = ? WHERE id = ?", [videoUrl, milestoneId]);
      if (videoUrl) {
        pushToUser(userId, {
          relation_milestone: true,
          milestone_id: milestoneId,
          stage: newStage.stage,
          stage_name: newStage.name,
          affection: newAffection,
          video_url: videoUrl,
        });
      }
    } else {
      let url1 = null, url2 = null;
      try {
        ({ url1, url2 } = await generateRelationComic(char.name, newStage.name, newAffection, char.personality, char.description, recentContext, plotSummary, { imageFallbackEnabled }));
      } catch (err) {
        console.error(`[milestone] 漫画生成失败:`, err.message);
      }
      await dbRun("UPDATE relationship_milestones SET comic_url_1 = ?, comic_url_2 = ? WHERE id = ?", [url1, url2, milestoneId]);
      pushToUser(userId, {
        relation_milestone: true,
        milestone_id: milestoneId,
        stage: newStage.stage,
        stage_name: newStage.name,
        affection: newAffection,
        comic_url_1: url1,
        comic_url_2: url2,
      });
    }
  })();
}

async function checkAndUnlockAchievements(userId, sessionId, { imageFallbackEnabled = true } = {}) {
  const achievements = await dbAll("SELECT * FROM achievements WHERE enabled = 1", []);
  if (!achievements.length) return;

  const char = await getActiveCharacter(userId);
  if (!char) return;

  const unlocked = await dbAll("SELECT achievement_id FROM user_achievements WHERE user_id = ? AND character_id = ?", [userId, char.id]);
  const unlockedIds = new Set(unlocked.map((r) => r.achievement_id));

  const [[msgRow]] = await getDb().execute(
    `SELECT COUNT(*) as n FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE m.user_id = ? AND m.role = 'user'
       AND EXISTS (SELECT 1 FROM messages m2 WHERE m2.session_id = m.session_id AND m2.role = 'assistant' AND m2.character_name = ?)`,
    [userId, char.name]
  );
  const msgCount = msgRow.n;
  const affection = char.affection ?? 0;
  const streakDays = char.streak_days ?? 0;

  const currentValues = { message_count: msgCount, affection, streak_days: streakDays };

  // 获取最近 50 条消息作为上下文，并生成剧情摘要
  let recentContext = "";
  let plotSummary = "";
  if (sessionId) {
    const recentMsgs = await dbAll(
      "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 50",
      [sessionId]
    );
    recentMsgs.reverse();
    recentContext = recentMsgs.slice(-5).map(m => `${m.role === 'user' ? '用户' : '角色'}：${m.content.slice(0, 100)}`).join("\n");
    plotSummary = await summarizePlot(recentMsgs).catch(() => "");
  }

  for (const ach of achievements) {
    if (unlockedIds.has(ach.id)) continue;
    const current = currentValues[ach.type];
    if (current === undefined || current < ach.threshold) continue;

    console.log(`[achievements] 尝试解锁：${ach.name}，当前值 ${current}，阈值 ${ach.threshold}`);

    // 先写入数据库占位，立即推送弹窗（不带图）
    let insertResult;
    try {
      insertResult = await dbRun(
        "INSERT IGNORE INTO user_achievements (user_id, achievement_id, character_id, selfie_url, inner_voice, unlocked_at) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, ach.id, char.id, null, null, nowIso()]
      );
    } catch (err) {
      console.error(`[achievements] 插入失败：${ach.name}`, err.message);
      continue;
    }

    if (!insertResult || insertResult.affectedRows === 0) {
      console.log(`[achievements] INSERT IGNORE 被忽略（已存在）：${ach.name}`);
      continue;
    }

    const insertId = insertResult.insertId;
    console.log(`[achievements] 用户 ${userId} 解锁成就：${ach.name}`);

    // 生成图和独白后再推送弹窗
    (async () => {
      let innerVoice, selfieUrl;
      try {
        [innerVoice, selfieUrl] = await Promise.all([
          generateAchievementInnerVoice(char.name, affection, ach.name, char.personality, recentContext),
          generateAchievementSelfie(userId, ach.name, ach.type, ach.threshold, char.personality, char.description, recentContext, plotSummary, { imageFallbackEnabled })
        ]);
      } catch (err) {
        console.error(`[achievements] 生成内容失败：${ach.name}`, err.message);
        innerVoice = null;
        selfieUrl = null;
      }
      await dbRun("UPDATE user_achievements SET selfie_url = ?, inner_voice = ? WHERE id = ?", [selfieUrl, innerVoice, insertId]);
      pushToSession(sessionId, {
        achievement_unlock: true,
        achievement: { id: ach.id, name: ach.name, type: ach.type, threshold: ach.threshold },
        selfie_url: selfieUrl,
        inner_voice: innerVoice,
        ua_id: insertId
      });
    })();
  }
}

server.listen(PORT, async () => {
  await initDb();
  await seedDefaultAchievements();
  const codeCount = await dbGet("SELECT COUNT(*) as n FROM invite_codes", []);
  if (codeCount.n === 0) {
    await dbRun("INSERT INTO invite_codes (code, created_at) VALUES (?, ?)", [DEFAULT_INVITE_CODE, nowIso()]);
    console.log(`已初始化邀请码：${DEFAULT_INVITE_CODE}`);
  }
  await ensureDefaultCharacter(null);
  const activeName = await getCharacterName(null);
  if (activeName && activeName !== "default") {
    // 只在有缺失头像时才预生成，避免每次重启都触发
    const appearance = await getCharacterAppearance(null);
    const appearanceHash = crypto.createHash("md5").update(appearance).digest("hex").slice(0, 8);
    const existing = await dbAll("SELECT mood FROM mood_avatars WHERE `character` = ? AND appearance_hash = ?", [activeName, appearanceHash]);
    const existingMoods = new Set(existing.map((r) => r.mood));
    const allMoods = Object.keys(MOOD_AVATAR_PROMPTS);
    const missing = allMoods.filter((m) => !existingMoods.has(m));
    if (missing.length > 0) {
      console.log(`情绪头像缺失 [${activeName}]: ${missing.join(", ")}，开始补全`);
      pregenerateMoodAvatars(activeName, missing, null).catch(() => {});
    }
  }
  console.log(`tornado 服务已启动: http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  server.close();
  closeDb();
  process.exit(0);
});
