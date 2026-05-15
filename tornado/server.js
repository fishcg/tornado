import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import OpenAI from "../node_modules/openai/index.js";
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
const PASSWORD_SALT = process.env.PASSWORD_SALT || "tornado-default-salt-2025";
const DEFAULT_INVITE_CODE = process.env.DEFAULT_INVITE_CODE || "tornado2025";

// ── 鉴权 ──────────────────────────────────────────────────────────────────────

const authSessions = new Map(); // sid -> { userId, username }

function hashPassword(password) {
  return crypto.createHash("sha256").update(password + PASSWORD_SALT).digest("hex");
}

function createAuthSession(userId, username) {
  const sid = crypto.randomBytes(32).toString("hex");
  authSessions.set(sid, { userId, username });
  return sid;
}

function getAuthSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!match) return null;
  return authSessions.get(match[1]) || null;
}

function requireAuth(req, res) {
  const session = getAuthSession(req);
  if (!session) { send(res, 401, { error: "unauthorized" }); return null; }
  return session;
}

async function requireAdmin(req, res) {
  const session = getAuthSession(req);
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

// flags bit layout: bit0=imageFallback, bit1=chatImage, bit2=imageAutoExpand, bit3=collapseAction
const FLAG_IMAGE_FALLBACK  = 1;
const FLAG_CHAT_IMAGE      = 2;
const FLAG_IMAGE_AUTOEXPAND = 4;
const FLAG_COLLAPSE_ACTION = 8;
const FLAGS_DEFAULT        = FLAG_CHAT_IMAGE; // 0b0010 = 2

async function getUserSettings(userId) {
  const row = await dbGet("SELECT * FROM user_settings WHERE user_id = ?", [userId]);
  const globalImageEnabled = (await getGlobalSetting("chat_image_enabled", "1")) !== "0";
  const flags = row ? (row.flags ?? FLAGS_DEFAULT) : FLAGS_DEFAULT;
  const base = {
    imageFallbackEnabled: !!(flags & FLAG_IMAGE_FALLBACK),
    chatImageEnabled:     !!(flags & FLAG_CHAT_IMAGE),
    imageAutoExpand:      !!(flags & FLAG_IMAGE_AUTOEXPAND),
    collapseAction:       !!(flags & FLAG_COLLAPSE_ACTION),
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

// ── 工具 ──────────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
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
  res.writeHead(200, { "Content-Type": mime[ext] || "text/plain" });
  fs.createReadStream(filePath).pipe(res);
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

async function llmChatStream(messages) {
  const t0 = Date.now();
  const stream = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages,
    stream: true,
    max_tokens: 300
  });
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
  const appearance = await getCharacterAppearance(userId);
  const desc = await getCharacterDescription(userId);
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

async function generateImage(prompt, sceneAnchor = "", { imageFallbackEnabled = true } = {}) {
  try {
    return await callImageApi(prompt);
  } catch (err) {
    if (err.status === 400) {
      console.log("生图被拒，尝试改写 prompt 重试...");
      const safePrompt = await rewriteSafePrompt(prompt);
      if (safePrompt) {
        const retryPrompt = sceneAnchor ? `${safePrompt}${sceneAnchor}` : safePrompt;
        console.log(`改写后: ${retryPrompt}`);
        try {
          return await callImageApi(retryPrompt);
        } catch (err2) {
          if (!imageFallbackEnabled) throw err2;
          console.log(`改写后仍失败，切换 DashScope 重试: ${err2.message}`);
          return await callImageApiFallback(retryPrompt);
        }
      }
    }
    if (!imageFallbackEnabled) throw err;
    console.log(`主 API 失败，切换 DashScope 重试: ${err.message}`);
    return await callImageApiFallback(prompt);
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

async function fireImageGeneration(msgId, prompt, sessionId, { silent = false, previousScene = null, imageFallbackEnabled = true, userId } = {}) {
  pendingImages.add(msgId);
  await updateMessageImagePrompt(msgId, prompt);
  const sanitized = sanitizeImagePrompt(prompt);
  const sceneAnchor = previousScene ? `（延续上一张的场景设定：${sanitizeImagePrompt(previousScene)}；若对话里没有明显转场请保持地点、服装、时段一致）` : "";
  const fullPrompt = `${await buildCharacterPromptPrefix(userId)}，${sanitized}${sceneAnchor}`;
  console.log(`${silent ? "自动" : "显式"}生图 [msg ${msgId}]: ${fullPrompt}`);
  generateImage(fullPrompt, sceneAnchor, { imageFallbackEnabled })
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

function buildSystemPrompt(soul, memoryContext, previousScene, mood, topicSummary, affection) {
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

  const parts = ["你是以下角色，请完全代入，直接以角色身份对话，不要解释自己是 AI。\n\n**严格控制回复长度**（必须遵守，优先级高于角色人设）：\n- 用户消息 ≤10字 → 你的回复不超过 30 字\n- 用户消息 11-50字 → 你的回复不超过 80 字\n- 用户消息 >50字 → 你的回复不超过 150 字\n- 用户明确要求长篇内容（如「写一段…」「不少于…」）时除外\n跟着对方的节奏来，对方说一句你也说一两句，不要主动展开长篇叙述。"];
  if (relationBlock) {
    parts.push("", "# 当前关系阶段（最高优先级，覆盖角色人设中的情感倾向）", relationBlock);
  }
  parts.push(
    "",
    "重要：如果用户在消息中明确要求字数（如'不少于1000字'、'写500字'），必须严格遵守，不得以角色风格为由缩减。",
    "",
    "# 角色设定",
    soul
  );
  if (memoryContext) parts.push("", "# 关于这个人，你记得的事", memoryContext);
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

  const prompt = `${await buildCharacterPromptPrefix(userId)}，半身照，竖版构图，精美动漫插画风格，单人，仅一个人物，人物居中，高质量`;
  let url = null;
  try {
    url = await callImageApi(prompt, { hd: true, aspectRatio: "2:3" });
  } catch (err) {
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

  const moodDesc = MOOD_AVATAR_PROMPTS[mood] || "neutral expression";
  const prompt = `${await buildCharacterPromptPrefix(userId)}，portrait headshot, ${moodDesc}, simple background, anime style`;
  let url = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      url = await callImageApi(prompt, { hd: false, aspectRatio: "1:1" });
      break;
    } catch (err) {
      console.log(`情绪头像生成失败 [${character}:${mood}] 第${attempt + 1}次: ${err.message}`);
      if (attempt === 2) {
        console.error(`情绪头像生成放弃 [${character}:${mood}]`);
        return null;
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
      checkAndUnlockAchievements(userId, sessionId).catch((e) => console.error("[achievements] 调用失败:", e.message));
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

async function generateProactiveMessage(sessionId, userId) {
  const msgs = await getMessages(sessionId);
  if (msgs.length === 0) return null;
  const charName = await getCharacterName(userId);
  const context = msgs.slice(-6).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  const session = await getSession(sessionId);  // internal use, no user isolation needed for proactive
  const soul = await loadSoul(userId);
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: `${soul}\n\n用户已经有一段时间没有说话了。根据之前的对话，主动发一条自然的消息，就像真实的人会做的那样——可以是随口一句、分享一件小事、或者接着之前的话题说点什么。不要问"你还在吗"这种话。保持角色口吻，简短自然。`
        },
        { role: "user", content: `最近对话：\n${context}` }
      ]
    });
    return (res.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
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
  return dbAll(`
    SELECT s.*,
      (SELECT content FROM messages WHERE session_id = s.id AND role != 'system' ORDER BY id DESC LIMIT 1) as last_message
    FROM sessions s WHERE s.archived = 0 AND s.user_id = ? ORDER BY updated_at DESC
  `, [userId]);
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
    const sid = createAuthSession(userId, username);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    res.end(JSON.stringify({ ok: true, username, is_new_user: true }));
    return;
  }

  if (method === "POST" && pathname === "/auth/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();
    if (!username || !password) { send(res, 400, { error: "缺少用户名或密码" }); return; }
    const user = await dbGet("SELECT * FROM users WHERE username = ?", [username]);
    if (!user || user.password_hash !== hashPassword(password)) { send(res, 401, { error: "用户名或密码错误" }); return; }
    const sid = createAuthSession(user.id, user.username);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    res.end(JSON.stringify({ ok: true, username: user.username }));
    return;
  }

  if (method === "POST" && pathname === "/auth/logout") {
    const cookie = req.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
    if (match) authSessions.delete(match[1]);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "sid=; HttpOnly; Path=/; Max-Age=0" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === "GET" && pathname === "/auth/me") {
    const session = getAuthSession(req);
    if (!session) { send(res, 401, { error: "unauthorized" }); return; }
    const user = await dbGet("SELECT is_admin FROM users WHERE id = ?", [session.userId]);
    send(res, 200, { id: session.userId, username: session.username, is_admin: user?.is_admin ? 1 : 0 });
    return;
  }

  // ── 静态文件（公开）────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/auth") {
    sendFile(res, path.join(PUBLIC_DIR, "auth.html"));
    return;
  }
  if (method === "GET" && pathname === "/") {
    // 未登录重定向到 /auth
    const session = getAuthSession(req);
    if (!session) {
      res.writeHead(302, { Location: "/auth" });
      res.end();
      return;
    }
    sendFile(res, path.join(PUBLIC_DIR, "index.html"));
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
    const session = getAuthSession(req);
    if (!session) { res.writeHead(302, { Location: "/auth" }); res.end(); return; }
    const user = await dbGet("SELECT is_admin FROM users WHERE id = ?", [session.userId]);
    if (!user?.is_admin) { res.writeHead(302, { Location: "/" }); res.end(); return; }
    sendFile(res, path.join(PUBLIC_DIR, "admin.html"));
    return;
  }

  // ── 所有 API 路由需要登录 ──────────────────────────────────────────────────
  const authSession = requireAuth(req, res);
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

    if (method === "GET" && pathname === "/admin/users") {
      const rows = await dbAll("SELECT id, username, is_admin, created_at FROM users ORDER BY id ASC", []);
      send(res, 200, rows);
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
        affection_interval: await getGlobalSetting("affection_interval", "3")
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
      if ("affection_interval" in body) {
        const n = Math.max(1, Math.min(20, Math.floor(Number(body.affection_interval) || 3)));
        await setGlobalSetting("affection_interval", String(n));
      }
      send(res, 200, {
        chat_image_enabled: await getGlobalSetting("chat_image_enabled", "1"),
        daily_scene_image_limit: await getGlobalSetting("daily_scene_image_limit", "5"),
        affection_interval: await getGlobalSetting("affection_interval", "3")
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
        if (url) broadcastCardUpdate(url);
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
    for (const row of rows) {
      if (row.appearance_hash === appearanceHash) avatars[row.mood] = row.image_url;
    }
    send(res, 200, { character: name, avatars });
    return;
  }

  // DELETE /avatars — 清除当前角色所有情绪头像，触发重新生成
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
      if (url) broadcastCardUpdate(url);
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
    broadcastCardUpdate(card.image_url);
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

  // PATCH /character/affection — 直接设置心动值
  if (method === "PATCH" && pathname === "/character/affection") {
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
    const sessions = await dbGet("SELECT id FROM sessions WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1", []);
    if (sessions) pushToSession(sessions.id, { affection_update: true, affection: value, delta });
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

  // GET /characters — 角色列表
  if (method === "GET" && pathname === "/characters") {
    const rows = await dbAll("SELECT id, name, is_active, created_at FROM characters WHERE user_id = ? ORDER BY id ASC", [userId]);
    send(res, 200, rows);
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
    if (body.is_active) {
      await dbRun("UPDATE characters SET is_active = 0 WHERE user_id = ?", [userId]);
      await dbRun("UPDATE characters SET is_active = 1 WHERE id = ? AND user_id = ?", [charId, userId]);
      const activated = await dbGet("SELECT name FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
      if (activated) pregenerateMoodAvatars(activated.name, null, userId).catch(() => {});
    }
    if (typeof body.name === "string") await dbRun("UPDATE characters SET name = ? WHERE id = ? AND user_id = ?", [body.name.trim(), charId, userId]);
    if (typeof body.soul_content === "string") await dbRun("UPDATE characters SET soul_content = ? WHERE id = ? AND user_id = ?", [body.soul_content.trim(), charId, userId]);
    send(res, 200, { ok: true });
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
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const ext = (req.headers["content-type"] || "").includes("png") ? ".png" : ".jpg";
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, buf);
    const imageUrl = `/uploads/${filename}`;
    const msgId = await appendMessage(sessionId, "user", "[图片]", null, userId);
    await updateMessageImage(msgId, imageUrl);

    // 等待图片识别完成再响应，让前端可以在识别后再显示图片
    const base64 = buf.toString("base64");
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    const dataUrl = `data:${mimeType};base64,${base64}`;
    try {
      const desc = await recognizeImage(dataUrl);
      if (desc) {
        await updateMessageImagePrompt(msgId, desc);
        await appendMessage(sessionId, "user", `（我发了一张图片，图片内容是：${desc}）`, null, userId);
        console.log(`用户图片识别 [msg ${msgId}]: ${desc}`);
      }
    } catch {}

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
    const imageFallbackEnabled = !!(settings.flags & 1);
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
    fireImageGeneration(targetMsgId, prompt, sessionId, { silent: false, imageFallbackEnabled, userId });
    send(res, 200, { ok: true, msg_id: targetMsgId });
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
    const shouldLookup = await needsMemoryLookup(userText, recent);
    if (shouldLookup) {
      const charName = await getCharacterName(userId);
      console.log("查询记忆中...");
      const [bgMemory, relMemory] = await Promise.all([
        queryMemory(`关于这个用户，我们聊过什么，他有哪些值得记住的事情`, charName, userId),
        queryMemory(userText, charName, userId)
      ]);
      const memoryParts = [];
      if (bgMemory) memoryParts.push(bgMemory);
      if (relMemory && relMemory !== bgMemory) memoryParts.push(relMemory);
      memoryContext = memoryParts.join("\n\n---\n\n") || null;
    }

    const soul = await loadSoul(userId);
    const previousScene = await getLastImagePrompt(sessionId);
    const { mood, topic_summary: topicSummary } = await getSession(sessionId, userId);
    const char = await getActiveCharacter(userId);
    const affection = char?.affection ?? null;
    const systemPrompt = buildSystemPrompt(soul, memoryContext, previousScene, mood, topicSummary, affection);
    console.log(memoryContext)
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

    let fullReply = "";
    try {
      const { stream, t0 } = await llmChatStream(messages);
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
          }
          fullReply += text;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
      return;
    }

    // 提取图片标记，存纯文字到数据库
    let { cleanText, prompt: imgPrompt } = extractImageTag(fullReply);
    let imgSilent = false;

    const settings = await getUserSettings(userId);
    if (!settings.chatImageEnabled) {
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
      fireImageGeneration(Number(msgId), imgPrompt, sessionId, { silent: imgSilent, previousScene, imageFallbackEnabled: settings.imageFallbackEnabled, userId });
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
    checkAndUnlockAchievements(userId, sessionId).catch((e) => console.error("[achievements] 调用失败:", e.message));

    res.end();
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
    const imageFallbackEnabled = !!(settings.flags & 1);
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

  // GET /sessions/:id/events — SSE，接收主动推送消息
  const eventsMatch = pathname.match(/^\/sessions\/(\d+)\/events$/);
  if (method === "GET" && eventsMatch) {
    const sessionId = Number(eventsMatch[1]);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      Connection: "keep-alive"
    });
    res.write(": connected\n\n");
    registerClient(sessionId, res);
    req.on("close", () => unregisterClient(sessionId, res));
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
    await saveUserSettings(userId, patch);
    send(res, 200, await getUserSettings(userId));
    return;
  }

  send(res, 404, { error: "not found" });
}

// ── 主动发消息（SSE 推送）────────────────────────────────────────────────────────

const sessionClients = new Map(); // sessionId -> Set<res>

function registerClient(sessionId, res) {
  if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
  sessionClients.get(sessionId).add(res);
}

function unregisterClient(sessionId, res) {
  sessionClients.get(sessionId)?.delete(res);
}

function pushToSession(sessionId, payload) {
  const clients = sessionClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch {}
  }
}

// 每 15 秒发一次 SSE comment，防止代理/浏览器因空闲超时断开连接
setInterval(() => {
  for (const [, clients] of sessionClients) {
    for (const res of clients) {
      try { res.write(": heartbeat\n\n"); } catch {}
    }
  }
}, 15000);

function broadcastCardUpdate(cardUrl) {
  const data = `data: ${JSON.stringify({ card_update: true, card_url: cardUrl })}\n\n`;
  for (const [, clients] of sessionClients) {
    for (const res of clients) {
      try { res.write(data); } catch {}
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
    // 更新 last_user_at 防止重复触发
    await dbRun("UPDATE sessions SET last_user_at = ? WHERE id = ?", [nowIso(), session.id]);
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
}, PROACTIVE_CHECK_MS);

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

async function generateAchievementSelfie(userId, achievementName, achType, achThreshold, personality, description, recentContext) {
  const appearance = await getCharacterAppearance(userId);

  const typeHint = {
    message_count: "与聊天、手机、文字相关的日常场景",
    affection:     "与情感、心动、甜蜜相关的温柔场景",
    streak_days:   "与日常坚持、时间流逝、陪伴相关的生活场景",
  }[achType] || "自然生活场景";

  const personalityHint = personality ? `角色性格：${personality}。` : "";
  const descriptionHint = description ? `角色背景：${description}。` : "";

  const sceneRes = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    max_tokens: 120,
    messages: [
      {
        role: "system",
        content: `你是一个图片描述生成助手。根据成就信息和最近对话，为角色生成一段自然生活照或自拍的场景描述，用于生成图片。
${personalityHint}${descriptionHint}
要求：
- 场景要与成就"${achievementName}"（类型：${typeHint}）在情感上匹配，并结合最近对话的氛围
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
  try {
    const fallbackPrompt = `${appearance}，自拍，自然光，动漫风格，高质量`;
    return await callImageApiFallback(fallbackPrompt, { aspectRatio: "1:1" });
  } catch {
    return null;
  }
}

async function checkAndUnlockAchievements(userId, sessionId) {
  const achievements = await dbAll("SELECT * FROM achievements WHERE enabled = 1", []);
  if (!achievements.length) return;

  const char = await getActiveCharacter(userId);
  if (!char) return;

  const unlocked = await dbAll("SELECT achievement_id FROM user_achievements WHERE user_id = ? AND character_id = ?", [userId, char.id]);
  const unlockedIds = new Set(unlocked.map((r) => r.achievement_id));

  const [[msgRow]] = await getDb().execute(`SELECT COUNT(*) as n FROM messages WHERE user_id = ? AND role = 'user'`, [userId]);
  const msgCount = msgRow.n;
  const affection = char.affection ?? 0;
  const streakDays = char.streak_days ?? 0;

  const currentValues = { message_count: msgCount, affection, streak_days: streakDays };

  // 获取最近 30 条消息作为上下文
  let recentContext = "";
  if (sessionId) {
    const recentMsgs = await dbAll(
      "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 30",
      [sessionId]
    );
    recentContext = recentMsgs.reverse().map(m => `${m.role === 'user' ? '用户' : '角色'}：${m.content}`).join("\n");
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
          generateAchievementSelfie(userId, ach.name, ach.type, ach.threshold, char.personality, char.description, recentContext)
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
        inner_voice: innerVoice
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
