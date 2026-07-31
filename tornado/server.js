import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { getDb, closeDb, initDb } from "./db.js";
import {
  PORT, MEMORY_API, OPENAI_API_KEY, OPENAI_API_URL, OPENAI_MODEL,
  DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL, IMAGE_API_URL, IMAGE_API_KEY,
  SOUL_PATH, PUBLIC_DIR, UPLOADS_DIR, PROACTIVE_IDLE_MINUTES, WEATHER_CITY,
  DEFAULT_INVITE_CODE,
  NEWAPI_API_KEY, NEWAPI_MODEL, openai, deepseek, newapi,
} from "./lib/config.js";
import { dbGet, dbAll, dbRun } from "./lib/dbutil.js";
import { uploadToOss } from "./lib/oss.js";
import {
  hashPassword, loadAuthSession, createAuthSession, deleteAuthSession,
  getAuthSession, requireAuth, requireAdmin,
} from "./lib/auth.js";
import { getGlobalSetting, setGlobalSetting } from "./lib/settings.js";
import { readBody, send, sendFile, sendHtmlWithAssetVersion } from "./lib/http.js";
import {
  extractImageTag, callImageApi, callImageApiFallback,
  generateImage, recognizeImage, sanitizeImagePrompt, fetchImageAsDataUrl,
} from "./lib/image.js";
import {
  cloneVoiceCosyVoice, deleteVoiceCosyVoice, synthesizeSpeechCosyVoice,
  summarizePlot, generateTtsStyle,
  translateToJapanese, normalizeTtsText,
  cloneVoiceQwenAudio, deleteVoiceQwenAudio, synthesizeSpeechQwenAudio,
  QWEN_AUDIO_TTS_FLASH, QWEN_AUDIO_TTS_PLUS,
} from "./lib/voice.js";
import {
  POINT_DEFAULTS, getConfig as getPointConfig, isEnabled as pointsEnabled,
  getAllConfig as getAllPointConfig, ensureAccount as ensurePointAccount,
  getBalance as getPointBalance, spend as spendPoints, grant as grantPoints,
  refund as refundPoints, getCheckinStatus, checkin as doCheckin,
  listCheckins, listCheckinsByMonth, listTransactions,
} from "./lib/points.js";

// ── 鉴权 ──────────────────────────────────────────────────────────────────────
// hashPassword/loadAuthSession/createAuthSession/deleteAuthSession/getAuthSession/
// requireAuth/requireAdmin 已抽到 lib/auth.js
// getGlobalSetting/setGlobalSetting 已抽到 lib/settings.js

// ── 客户端 UA 解析 & 版本比较 ──────────────────────────────────────────────────
// 解析形如 "tornadoApp/0.1.0 (android 14)" 的 UA；非 App 客户端返回 null。
// 兜底：UA 取不到版本时读 X-Client-Version 头。
function parseClientInfo(req) {
  const ua = String(req.headers["user-agent"] || "");
  const m = ua.match(/tornadoApp\/(\d+(?:\.\d+){0,2})(?:\s*\(([^)]*)\))?/i);
  let version = null;
  let os = null;
  let osVersion = null;
  if (m) {
    version = m[1];
    if (m[2]) {
      const parts = m[2].trim().split(/\s+/);
      os = (parts[0] || "").toLowerCase() || null;
      osVersion = parts[1] || null;
    }
  }
  // 兜底头（部分平台 fetch 会覆盖 UA）
  if (!version) {
    const hv = req.headers["x-client-version"];
    if (hv) version = String(hv).trim();
    const ho = req.headers["x-client-os"];
    if (ho) {
      const parts = String(ho).trim().split(/\s+/);
      os = (parts[0] || "").toLowerCase() || os;
      osVersion = parts[1] || osVersion;
    }
  }
  if (!version) return null; // 非 App 客户端
  return { isApp: true, version, os, osVersion, ua };
}

// 语义化版本比较：a<b 返回 -1，a==b 返回 0，a>b 返回 1。非法输入按 0 段处理。
function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// 取某平台 enabled 的最新版本（按语义化版本号取最大；行数很少，JS 内排序）
async function getLatestAppVersion(platform = "android") {
  const rows = await dbAll(
    "SELECT version_name, release_notes, download_url, force_update FROM app_versions WHERE platform = ? AND enabled = 1",
    [platform]
  );
  if (!rows.length) return null;
  rows.sort((a, b) => compareVersions(b.version_name, a.version_name));
  return rows[0];
}

// ── MySQL 辅助函数 ─────────────────────────────────────────────────────────────
// dbGet/dbAll/dbRun 已抽到 lib/dbutil.js

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

// 按声音渠道选择合成 / 克隆 / 删除函数，新增渠道只需在此登记
// 默认渠道为 cosyvoice（支持流式，多数角色在用）
// qwen-audio = Qwen-Audio-TTS flash，qwen-audio-plus = plus（仅模型名不同）
const TTS_CHANNELS = ["cosyvoice", "qwen-audio", "qwen-audio-plus"];
const QWEN_AUDIO_CHANNELS = new Set(["qwen-audio", "qwen-audio-plus"]);
function qwenAudioModel(channel) {
  return channel === "qwen-audio-plus" ? QWEN_AUDIO_TTS_PLUS : QWEN_AUDIO_TTS_FLASH;
}
function pickSynthFn(channel) {
  if (QWEN_AUDIO_CHANNELS.has(channel)) {
    const model = qwenAudioModel(channel);
    return (text, voiceId, lang, instruction) => synthesizeSpeechQwenAudio(text, voiceId, lang, instruction, model);
  }
  return synthesizeSpeechCosyVoice;
}
function pickDeleteVoiceFn(channel) {
  return QWEN_AUDIO_CHANNELS.has(channel) ? deleteVoiceQwenAudio : deleteVoiceCosyVoice;
}
function pickCloneVoiceFn(channel) {
  if (QWEN_AUDIO_CHANNELS.has(channel)) {
    const model = qwenAudioModel(channel);
    return (audioUrl, charId) => cloneVoiceQwenAudio(audioUrl, charId, model);
  }
  return cloneVoiceCosyVoice;
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
  const defaults = char.name === DEFAULT_CHARACTER.name ? DEFAULT_CHARACTER : {};
  if (char.name) parts.push(`# 角色名称\n\n${char.name}`);
  if (char.appearance) parts.push(`# 外貌\n\n${char.appearance}`);
  if (char.personality) parts.push(`# 性格\n\n${char.personality}`);
  if (char.description) parts.push(`# 人物说明\n\n${char.description}`);
  const valuesContent = char.values_content || defaults.values_content;
  const boundariesContent = char.boundaries_content || defaults.boundaries_content;
  const habitsContent = char.habits_content || defaults.habits_content;
  const speechExamples = char.speech_examples || defaults.speech_examples;
  if (valuesContent) parts.push(`# 价值观与在意的事\n\n${valuesContent}`);
  if (boundariesContent) parts.push(`# 边界与雷区\n\n${boundariesContent}`);
  if (habitsContent) parts.push(`# 习惯与生活细节\n\n${habitsContent}`);
  if (speechExamples) parts.push(`# 说话示例与反例\n\n${speechExamples}`);
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
  const text = String(userText || "").trim();
  if (!text) return false;
  // 明确回忆、延续、偏好和人物关系问题必须查；纯招呼、语气词和即时指令不查。
  if (/之前|以前|上次|还记得|记不记得|我说过|答应|约好|后来|又|还是|一直|平时|喜欢|讨厌|习惯|家人|朋友|工作|生日|名字/.test(text)) return true;
  if (/^(你好|嗨|哈喽|早|早安|晚安|在吗|嗯+|哦+|好+|哈哈+|行|可以|知道了|继续|然后呢)[呀啊呢嘛吧。！!？?~～]*$/.test(text)) return false;
  if (text.length <= 4) return false;
  // 最近一句角色回复若主动提到了过去或未完事项，用户的承接句也需要记忆支撑。
  const lastAssistant = [...recentMsgs].reverse().find((msg) => msg.role === "assistant")?.content || "";
  if (/之前|上次|记得|答应|还没|后来/.test(lastAssistant)) return true;
  return /我|你|我们|怎么|为什么|什么/.test(text) && text.length >= 10;
}

async function queryMemory(question, characterName, userId) {
  try {
    const params = new URLSearchParams({ q: question });
    const sourcePrefix = userId ? `tornado-${userId}-${characterName}` : (characterName ? `tornado-${characterName}` : null);
    if (sourcePrefix) {
      params.set("source", sourcePrefix);
      params.set("exact", "1");
    }
    const res = await fetch(`${MEMORY_API}/query?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.answer || null;
  } catch {
    return null;
  }
}

async function queryEntityGraph(characterName, userId, question = "") {
  if (!String(question || "").trim()) return null;
  try {
    const sourcePrefix = userId ? `tornado-${userId}-${characterName}` : (characterName ? `tornado-${characterName}` : null);
    const params = new URLSearchParams({ limit: "100" });
    if (sourcePrefix) {
      params.set("source", sourcePrefix);
      params.set("exact", "1");
    }
    const res = await fetch(`${MEMORY_API}/graph?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.edges?.length) return null;
    const normalizedQuestion = String(question).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const stopTerms = new Set(["我们", "你们", "他们", "这个", "那个", "什么", "怎么", "为什么", "还是", "就是", "然后", "现在", "今天"]);
    const terms = new Set();
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i + size <= normalizedQuestion.length; i++) {
        const term = normalizedQuestion.slice(i, i + size);
        if (!stopTerms.has(term)) terms.add(term);
      }
    }
    const lines = data.edges
      .map((edge) => {
        const text = `${edge.source}${edge.relationship}${edge.target}`.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
        let relevance = 0;
        for (const term of terms) if (text.includes(term)) relevance += term.length >= 3 ? 2 : 1;
        return { edge, relevance };
      })
      .filter((item) => item.relevance >= 2)
      .sort((a, b) => b.relevance - a.relevance || (b.edge.weight || 0) - (a.edge.weight || 0))
      .slice(0, 5)
      .map(({ edge: e }) => `${e.source} → ${e.relationship} → ${e.target}`);
    if (!lines.length) return null;
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

// 激活角色的参考图 URL（用于图生图，保持形象统一）；无则返回 null
async function getCharacterReferenceImageUrl(userId) {
  try {
    const char = await getActiveCharacter(userId);
    return char?.reference_image_url || null;
  } catch {
    return null;
  }
}

// 拉取激活角色参考图并转成 Data URL；无参考图或拉取失败返回 null
async function getCharacterReferenceDataUrl(userId) {
  const url = await getCharacterReferenceImageUrl(userId);
  if (!url) return null;
  return await fetchImageAsDataUrl(url);
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

async function fireImageGeneration(msgId, prompt, sessionId, { silent = false, previousScene = null, imageFallbackEnabled = true, userId, aspectRatio = null, refund = null } = {}) {
  pendingImages.add(msgId);
  await updateMessageImagePrompt(msgId, prompt);
  const sanitized = sanitizeImagePrompt(prompt);
  const sceneAnchor = previousScene ? `（延续上一张的场景设定：${sanitizeImagePrompt(previousScene)}；若对话里没有明显转场请保持地点、服装、时段一致）` : "";
  const fullPrompt = `${await buildCharacterPromptPrefix(userId)}，${sanitized}${sceneAnchor}`;
  const referenceDataUrl = await getCharacterReferenceDataUrl(userId);
  console.log(`${silent ? "自动" : "显式"}生图 [msg ${msgId}]${referenceDataUrl ? "（图生图）" : ""}: ${fullPrompt}`);
  generateImage(fullPrompt, sceneAnchor, { imageFallbackEnabled, aspectRatio, referenceDataUrl })
    .then(async (url) => {
      await updateMessageImage(msgId, url);
      console.log(`生图完成 [msg ${msgId}]: ${url}`);
      pushToSession(sessionId, { image_ready: true, msg_id: msgId, url });
      const desc = await recognizeImage(url);
      if (desc) {
        // 用实际画面描述更新场景记录，比生成时的 prompt 更准确
        await updateMessageImagePrompt(msgId, desc);
        if (!silent) {
          await appendMessage(sessionId, "assistant", `（我刚拍的照片里是这样的：${desc}）`, await getCharacterName(userId), userId);
          console.log(`图片识别 [msg ${msgId}]: ${desc}`);
        }
      }
    })
    .catch(async (err) => {
      console.error(`生图失败 [msg ${msgId}]:`, err.message);
      pushToSession(sessionId, { image_failed: true, msg_id: msgId });
      // 异步生成失败 → 退还已扣的小鱼干（按 reason+ref 幂等）
      if (refund && userId) {
        try {
          await refundPoints(userId, refund.amount, refund.reason, refund.ref);
          console.log(`[退款] 生图失败退还 ${refund.amount} 小鱼干 [msg ${msgId}]`);
          pushToUser(userId, { points_refunded: true, amount: refund.amount });
        } catch (e) {
          console.error(`[退款] 失败 [msg ${msgId}]:`, e.message);
        }
      }
    })
    .finally(() => {
      pendingImages.delete(msgId);
    });
}

function clampScore(value, fallback = 0) {
  const n = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(n) ? Math.round(n) : fallback));
}

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getRelationshipState(char) {
  const affection = clampScore(char?.affection, 10);
  return {
    affection,
    trust: clampScore(char?.trust_score, Math.min(100, affection + 8)),
    warmth: clampScore(char?.warmth_score, affection),
    intimacy: clampScore(char?.intimacy_score, Math.max(0, Math.round((affection - 15) * 1.15))),
    tension: clampScore(char?.tension_score, affection < 25 ? 25 : 8)
  };
}

function getEffectiveMoodState(session) {
  const mood = session?.mood || "neutral";
  let intensity = clampScore(session?.mood_intensity, mood === "neutral" ? 0 : 45);
  if (session?.mood_updated_at) {
    const ageHours = Math.max(0, (Date.now() - new Date(session.mood_updated_at).getTime()) / 3600000);
    intensity = Math.max(0, Math.round(intensity - ageHours * 12));
  }
  return {
    mood: intensity < 15 ? "neutral" : mood,
    intensity,
    cause: intensity < 15 ? "" : String(session?.mood_cause || "").slice(0, 80)
  };
}

function buildSystemPrompt({ soul, memoryContext, previousScene, moodState, relationship, entityGraph, achievementStage, otherChars, diary, behaviorHint, innerState, channel = "chat" }) {
  const relationBlock = relationship ? [
    `信任 ${relationship.trust}/100，亲近意愿 ${relationship.warmth}/100，亲密程度 ${relationship.intimacy}/100，当前紧张感 ${relationship.tension}/100。`,
    "这些数值只表示关系的方向和程度，不替代角色性格。必须用角色自己的方式表达亲疏：同样的在意，嘴硬的人会别扭，直率的人会直接，克制的人会少说。",
    relationship.intimacy < 35
      ? "当前亲密基础较浅，面对突然表白或肢体亲近时要保持符合角色边界的谨慎，不要无缘无故迅速升温。"
      : relationship.intimacy < 70
        ? "关系已有基础，可以自然关心和试探，但仍保留角色自身的分寸感。"
        : "关系足够亲密，可以自然表达依恋和默契，但不要每句话都撒娇或重复表白。",
    relationship.tension >= 55 ? "当前仍有明显芥蒂；在对方解释或修复之前，情绪不要毫无过渡地恢复。" : ""
  ].filter(Boolean).join("\n") : null;

  let familiarityBlock = null;
  if (achievementStage >= 1) {
    const stages = [
      null,
      `【相处阶段：相识，已解锁第一个里程碑】
你们已经有了一些共同经历。行为准则：
- 开始记住对方的习惯和偏好，但只在与当前内容直接相关时自然使用
- 语气比初识时更放松，但仍保持适当距离`,
      `【相处阶段：熟识，已积累相当多的共同时光】
你们已经很熟悉了。行为准则：
- 可以用昵称或更亲切的称呼，语气随意自然
- 能接住共同回忆，但用户正在聊新话题时不要主动翻旧账
- 聊天不需要刻意找话题，沉默也不尴尬`,
      `【相处阶段：深交，已达到最深的关系里程碑】
你们之间有深厚的共同历史。行为准则：
- 非常了解对方，能感知对方情绪的细微变化
- 只有在当前话题自然勾连时，才会提起两个人都懂的共同回忆
- 语气亲密、真实，不需要任何表演或刻意`
    ];
    familiarityBlock = stages[achievementStage];
  }

  const parts = ["你是以下角色，请完全代入，直接以角色身份对话，不要解释自己是 AI。\n\n**严格控制回复长度**（必须遵守，优先级高于角色人设）：\n- 用户消息 ≤10字 → 你的回复通常不超过 30 字\n- 用户消息 11-50字 → 你的回复通常不超过 80 字\n- 用户消息 >50字 → 你的回复通常不超过 150 字\n- 用户明确要求长篇内容时完整满足\n跟着对方的节奏来。允许偶尔停顿、简短反问、没把话说满，不要每次都总结、安慰或给建议。\n\n**当前话题优先级最高**：\n- 只围绕用户最新一句真正想聊的内容回应；用户转向新话题，就立刻跟着转向。\n- 现实中的事情尚未发生或尚未结束，不等于这个话题必须继续。例如用户说“准备去吃火锅”，之后开始聊电影，就只聊电影，不要反复补一句“吃火锅前/吃完火锅后”。\n- 普通计划、吃饭、通勤、洗澡、睡觉、上班、购物等都不是待办任务，不要持续追踪进度。\n- 旧话题只有在用户主动重新提起，或与当前问题有直接因果关系时才能再次出现。\n- 一个具体例子提过一次就够了；不要把记忆、日记、场景或角色意图当成必须说出口的内容。\n- 不要每轮都提问。陈述、调侃、沉默式短回应和主动分享可以交替出现。"];
  if (relationBlock) {
    parts.push("", "# 当前关系状态", relationBlock);
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
  if (innerState && channel !== "chat") {
    const stateLines = [];
    if (innerState.current_activity) stateLines.push(`你最近在做：${innerState.current_activity}`);
    if (innerState.proactive_seed) stateLines.push(`可选的主动分享念头：${innerState.proactive_seed}`);
    if (Array.isArray(innerState.commitments) && innerState.commitments.length) stateLines.push(`明确承诺或提醒：${innerState.commitments.slice(0, 3).join("；")}`);
    if (stateLines.length) parts.push("", "# 你的短期状态", stateLines.join("\n") + "\n（这些只是后台候选。最多选一个真正适合当前时机的点；普通生活事件未完成不代表要追问，已经提过的不要重复。）");
  }
  if (entityGraph) parts.push("", "# 关于这个人，已确认的关系与事实", entityGraph + "\n（只在相关时使用，不要像数据库一样罗列。）");
  if (memoryContext) parts.push("", "# 与当前话题相关的记忆", memoryContext + "\n（自然使用事实，不要念出 Memory 编号或声称自己在检索资料；若与用户最新说法冲突，以最新说法为准。）");
  if (otherChars?.length) {
    const names = otherChars.map(c => c.name).join("、");
    parts.push("", "# 你知道的其他人", `这个人除了和你聊天，还和 ${names} 有联系。你可以偶尔自然地流露出对此的感知——比如轻微的好奇、若有若无的在意，或者不经意地提起。不要刻意追问，也不要表现得过于在乎，保持符合你性格的自然反应即可。`);
  }
  if (previousScene) parts.push("", "# 上一张图片的场景", `${previousScene}\n写 [IMG:] 标记时，默认延续这个场景的地点、服装、时段，除非对话里出现明显转场。`);
  if (moodState?.mood && moodState.mood !== "neutral") {
    const keepCause = ["angry", "cold", "annoyed"].includes(moodState.mood) && moodState.cause;
    parts.push("", "# 当前情绪状态", `你现在主要是 ${moodState.mood}，强度约 ${moodState.intensity}/100${keepCause ? `，尚未消化的原因是：${moodState.cause}` : ""}。情绪只影响语气，不代表要继续之前的话题，也不要直接报出情绪标签。`);
  }
  return parts.join("\n");
}

const sessionStateUpdates = new Map();

async function waitForPendingStateUpdate(sessionId) {
  const pending = sessionStateUpdates.get(sessionId);
  if (pending) await pending.catch(() => {});
}

function trackSessionStateUpdate(sessionId, promise) {
  sessionStateUpdates.set(sessionId, promise);
  promise.finally(() => {
    if (sessionStateUpdates.get(sessionId) === promise) sessionStateUpdates.delete(sessionId);
  });
  return promise;
}

async function buildConversationContext(sessionId, userId, { memoryQuestion = null, lookupMemory = false, includeBehavior = true, channel = "chat" } = {}) {
  const [char, soul, session, previousScene] = await Promise.all([
    getActiveCharacter(userId),
    loadSoul(userId),
    getSession(sessionId, userId),
    getLastImagePrompt(sessionId)
  ]);
  const charName = char?.name || await getCharacterName(userId);
  const [entityGraph, memoryContext, diary, behaviorHint, achievementStage] = await Promise.all([
    lookupMemory && memoryQuestion ? queryEntityGraph(charName, userId, memoryQuestion) : Promise.resolve(null),
    lookupMemory && memoryQuestion ? queryMemory(memoryQuestion, charName, userId) : Promise.resolve(null),
    channel === "chat" ? Promise.resolve(null) : getLatestDiary(userId, char?.id),
    includeBehavior ? detectBehaviorPattern(userId, sessionId) : Promise.resolve(null),
    char ? getAchievementStage(userId, char.id) : Promise.resolve(0)
  ]);

  let otherChars = null;
  const multiCharEnabled = (await getGlobalSetting("multi_char_awareness", "0")) === "1";
  if (multiCharEnabled && char) {
    const rows = await dbAll("SELECT name FROM characters WHERE user_id = ? AND is_active = 0 ORDER BY id DESC LIMIT 5", [userId]);
    if (rows.length) otherChars = rows;
  }

  const relationship = getRelationshipState(char);
  const moodState = getEffectiveMoodState(session);
  const innerState = parseJsonObject(char?.inner_state_json, {});
  const systemPrompt = buildSystemPrompt({
    soul,
    memoryContext,
    previousScene,
    moodState,
    relationship,
    entityGraph,
    achievementStage,
    otherChars,
    diary,
    behaviorHint,
    innerState,
    channel
  });
  return { systemPrompt, char, charName, session, previousScene, relationship, moodState, innerState, memoryContext, entityGraph, diary, behaviorHint };
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
  const referenceDataUrl = await getCharacterReferenceDataUrl(userId);
  let url = null;
  // 有参考图先走图生图；失败降级为普通文生图
  if (referenceDataUrl) {
    try {
      url = await callImageApi(prompt, { hd: true, aspectRatio: "2:3", referenceDataUrl });
    } catch (err) {
      console.log(`角色卡片图生图失败，降级文生图: ${err.message}`);
    }
  }
  if (!url) {
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
  const referenceUrl = await getCharacterReferenceImageUrl(userId);
  // 参考图 URL 纳入 hash：设置/更换参考图后旧头像缓存自动失效
  const appearanceHash = crypto.createHash("md5").update(appearance + "|" + (referenceUrl || "")).digest("hex").slice(0, 8);
  const existing = await dbGet("SELECT image_url, appearance_hash FROM mood_avatars WHERE `character` = ? AND mood = ? AND (user_id = ? OR user_id IS NULL)", [character, mood, userId ?? null]);
  if (existing && existing.appearance_hash === appearanceHash) return existing.image_url;

  const settings = userId ? await getUserSettings(userId) : { imageFallbackEnabled: true };
  const moodDesc = MOOD_AVATAR_PROMPTS[mood] || "neutral expression";
  const prefix = await buildCharacterPromptPrefix(userId);
  const prompt = `${prefix}，头像特写，${moodDesc}，纯色背景，动漫风格，高质量`;
  const referenceDataUrl = referenceUrl ? await fetchImageAsDataUrl(referenceUrl) : null;
  let url = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      // 有参考图走图生图；最后一次仍失败时退回普通文生图
      url = await callImageApi(prompt, {
        hd: false, aspectRatio: "1:1",
        referenceDataUrl: attempt < 2 ? referenceDataUrl : null
      });
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

async function updateMood(sessionId, recentMsgs, userId, targetMsgId = null) {
  const char = await getActiveCharacter(userId);
  const charName = char?.name || await getCharacterName(userId);
  const session = await getSession(sessionId, userId);
  const previousMood = getEffectiveMoodState(session);
  const previousInner = parseJsonObject(char?.inner_state_json, {});
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
          content: `你负责维护${charName}连续的短期心理状态。结合上一状态和最新对话，更新情绪与尚未完成的事情。

可选情绪：neutral（平静）、shy（害羞）、annoyed（不耐烦）、soft（温柔）、flustered（慌乱）、playful（俏皮）、cold（冷淡）、happy（开心）、angry（生气）

判断原则：
- 看情绪的本质，不看表面措辞。用调侃语气说告别/表达受伤 → cold 或 annoyed，不是 playful
- 表面开玩笑但实质是在掩盖难过/失望 → cold 或 annoyed
- 真正在玩闹、互动轻松愉快 → playful
- 重点参考${charName}最新回复的情绪走向，而不是整段对话的平均情绪
- 情绪有惯性。没有明显刺激时不要从强烈负面直接跳到开心，也不要因为一句普通话产生极端情绪
- commitments 只保留明确需要日后兑现的承诺、用户明确要求的提醒、或者角色尚未回答的直接问题，最多3条
- 普通生活计划或进行中的事情绝对不是 commitment：去吃火锅、吃饭、通勤、洗澡、睡觉、上班、购物、看电影，即使还没发生或没结束也不要保存
- 用户换话题后，不要因为旧事情“还没完成”就继续追踪；对话是否结束由用户当前关注点决定，不由现实事件进度决定
- current_activity 只能写角色自己正在做的具体小事，不能把用户的行程写成角色状态
- proactive_seed 只能是角色自己以后可能分享的一件小事，不能是追问用户旧话题，也不能重复上一轮已经说过的内容

严格只输出一行 JSON，不要解释：
{"mood":"soft","intensity":45,"cause":"他认真关心了我","current_activity":"在窗边喝茶","proactive_seed":"新买的杯子颜色有点奇怪","commitments":["答应明天把照片发给他"]}
intensity 为0到100整数，cause 20字以内，三个文本字段都要简短。`
        },
        {
          role: "user",
          content: `上一情绪：${previousMood.mood}，强度${previousMood.intensity}${previousMood.cause ? `，原因：${previousMood.cause}` : ""}\n上一短期状态：${JSON.stringify(previousInner)}\n\n最新对话：\n${context}`
        }
      ]
    });
    let raw = (res.choices?.[0]?.message?.content || "").trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { mood: raw.split(/\s/)[0] }; }
    const mood = String(parsed.mood || "neutral").trim();
    const valid = ["neutral", "shy", "annoyed", "soft", "flustered", "playful", "cold", "happy", "angry"];
    const finalMood = valid.includes(mood) ? mood : "neutral";
    const intensity = clampScore(parsed.intensity, finalMood === "neutral" ? 0 : 45);
    const cause = String(parsed.cause || "").trim().slice(0, 80);
    await dbRun(
      "UPDATE sessions SET mood = ?, mood_intensity = ?, mood_cause = ?, mood_updated_at = ? WHERE id = ?",
      [finalMood, intensity, cause || null, nowIso(), sessionId]
    );
    if (char) {
      const previousCommitments = Array.isArray(previousInner.commitments)
        ? previousInner.commitments.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
        : [];
      const innerState = {
        current_activity: String(parsed.current_activity || "").trim().slice(0, 100),
        proactive_seed: String(parsed.proactive_seed || "").trim().slice(0, 120),
        commitments: Array.isArray(parsed.commitments)
          ? parsed.commitments.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
          : previousCommitments
      };
      await dbRun("UPDATE characters SET inner_state_json = ? WHERE id = ?", [JSON.stringify(innerState), char.id]);
    }
    // 把当时情绪快照写到目标 assistant 消息上（供收藏展示）；未指定则取最近一条
    if (targetMsgId) {
      await dbRun("UPDATE messages SET mood = ? WHERE id = ?", [finalMood, targetMsgId]);
    } else {
      await dbRun(
        "UPDATE messages SET mood = ? WHERE id = (SELECT id FROM (SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1) t)",
        [finalMood, sessionId]
      );
    }
    generateMoodAvatar(finalMood, userId).then((avatarUrl) => {
      pushToSession(sessionId, { mood_update: true, mood: finalMood, avatar_url: avatarUrl });
    }).catch(() => {
      pushToSession(sessionId, { mood_update: true, mood: finalMood, avatar_url: null });
    });
    return finalMood;
  } catch {
    return previousMood.mood || "neutral";
  }
}

async function updateAffection(sessionId, recentMsgs, userId) {
  const char = await getActiveCharacter(userId);
  if (!char) return;
  const charName = char.name;
  const relationship = getRelationshipState(char);
  const current = relationship.affection;
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
          content: `你负责更新角色与用户之间连续的关系状态。根据最近对话判断【用户行为】带来的细微变化，不要把所有正面互动都等同于恋爱升温。
${personality}当前状态：心动${relationship.affection}，信任${relationship.trust}，温暖${relationship.warmth}，亲密${relationship.intimacy}，紧张${relationship.tension}。${relationStage}。

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

严格只输出一行 JSON：{"affection_delta":整数,"trust_delta":整数,"warmth_delta":整数,"intimacy_delta":整数,"tension_delta":整数,"reason":"一句话"}
- 每个关系增量范围 -5 到 +5；普通聊天全部为0很正常
- trust 表示是否可靠和安心；warmth 表示当下亲近意愿；intimacy 表示能否接受私密或亲密互动；tension 表示芥蒂、压力和防备
- 道歉和解释通常先降低 tension，再慢慢恢复 trust，不要一次全部复原
- reason 是${charName}内心的真实感受，第一人称，15字以内，口语化
不要输出其他内容。`
        },
        { role: "user", content: context }
      ]
    });
    let deltas = { affection: 0, trust: 0, warmth: 0, intimacy: 0, tension: 0 }, reason = null;
    try {
      let raw = (res.choices?.[0]?.message?.content || "").trim();
      // 去掉可能的 markdown 代码块包裹
      raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(raw);
      deltas = {
        affection: parseInt(parsed.affection_delta ?? parsed.delta, 10) || 0,
        trust: parseInt(parsed.trust_delta, 10) || 0,
        warmth: parseInt(parsed.warmth_delta, 10) || 0,
        intimacy: parseInt(parsed.intimacy_delta, 10) || 0,
        tension: parseInt(parsed.tension_delta, 10) || 0
      };
      reason = parsed.reason || null;
    } catch (e) {
      console.log("[affection] JSON parse failed:", res.choices?.[0]?.message?.content, e.message);
      return;
    }
    const clamped = Object.fromEntries(Object.entries(deltas).map(([key, value]) => [key, Math.max(-5, Math.min(5, value))]));
    const next = {
      affection: clampScore(relationship.affection + clamped.affection),
      trust: clampScore(relationship.trust + clamped.trust),
      warmth: clampScore(relationship.warmth + clamped.warmth),
      intimacy: clampScore(relationship.intimacy + clamped.intimacy),
      tension: clampScore(relationship.tension + clamped.tension)
    };
    if (Object.values(clamped).some((value) => value !== 0)) {
      const sessionRow = await dbGet("SELECT mood FROM sessions WHERE id = ?", [sessionId]);
      const sessionMood = sessionRow?.mood || "neutral";
      await dbRun(
        "UPDATE characters SET affection = ?, trust_score = ?, warmth_score = ?, intimacy_score = ?, tension_score = ? WHERE id = ?",
        [next.affection, next.trust, next.warmth, next.intimacy, next.tension, char.id]
      );
      if (clamped.affection !== 0) {
        await dbRun("INSERT INTO affection_log (character_id, delta, value, mood, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)", [char.id, clamped.affection, next.affection, sessionMood, reason, nowIso()]);
        console.log(`[affection] ${charName} ${clamped.affection > 0 ? "+" : ""}${clamped.affection} → ${next.affection} | ${reason}`);
        pushToSession(sessionId, { affection_update: true, affection: next.affection, delta: clamped.affection });
      }
      const settings = await getUserSettings(userId);
      checkAndUnlockAchievements(userId, sessionId, settings).catch((e) => console.error("[achievements] 调用失败:", e.message));
      if (clamped.affection !== 0) checkRelationshipMilestone(userId, sessionId, current, next.affection, settings).catch((e) => console.error("[milestone] 调用失败:", e.message));

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
  await waitForPendingStateUpdate(sessionId);
  const msgs = await getMessages(sessionId);
  if (msgs.length === 0) return null;
  const lastUserText = [...msgs].reverse().find((msg) => msg.role === "user")?.content || "";
  const { systemPrompt, charName } = await buildConversationContext(sessionId, userId, {
    memoryQuestion: lastUserText,
    lookupMemory: !!lastUserText,
    channel: "proactive"
  });
  const context = msgs.slice(-6).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  const bgContext = await buildProactiveContext();
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: `${systemPrompt}\n\n# 当前沟通方式：主动消息\n当前背景：${bgContext}\n用户有一段时间没说话了。像真实的人一样选择一个自然动机发消息：延续真正没聊完的事、兑现承诺、分享你此刻的一件小事，或者在确实相关时提到时间天气。不要默认问“在吗”“怎么不回”，不要每次都提天气，也不要编造重大经历。只发一条简短口语消息。`
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
    "SELECT content, created_at FROM character_diaries WHERE user_id = ? AND character_id = ? ORDER BY id DESC LIMIT 1",
    [userId, characterId]
  );
  if (row?.created_at && Date.now() - new Date(row.created_at).getTime() > 7 * 86400000) return null;
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
  const localNow = new Date();
  const today = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}`;
  const lastChatDate = rows[0]?.d ? new Date(rows[0].d) : null;
  const lastChatDay = lastChatDate
    ? `${lastChatDate.getFullYear()}-${String(lastChatDate.getMonth() + 1).padStart(2, "0")}-${String(lastChatDate.getDate()).padStart(2, "0")}`
    : null;
  if (lastChatDate && lastChatDay !== today) {
    const gapDays = Math.floor((Date.now() - lastChatDate.getTime()) / 86400000);
    if (gapDays >= 2) {
      hints.push(`用户已经 ${gapDays} 天没来找你了（之前几乎每天都会来）`);
    }
  }

  const recentHours = rows.slice(0, 7).map(r => new Date(r.first_msg_at).getHours());
  const avgHour = recentHours.reduce((a, b) => a + b, 0) / recentHours.length;
  const sessionFirstMsg = await dbGet(
    "SELECT created_at FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
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
  await waitForPendingStateUpdate(sessionId);
  const msgs = await getMessages(sessionId);
  if (msgs.length === 0) return null;
  const lastUserText = [...msgs].reverse().find((msg) => msg.role === "user")?.content || "";
  const { systemPrompt, charName } = await buildConversationContext(sessionId, userId, {
    memoryQuestion: lastUserText,
    lookupMemory: !!lastUserText,
    channel: "call"
  });
  const context = msgs.slice(-10).map((m) =>
    `${m.role === "user" ? "用户" : charName}：${m.content}`
  ).join("\n");
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: `${systemPrompt}\n\n# 当前沟通方式：电话\n你正在给用户打电话。根据关系状态和最近对话，自然说明来意；可以关心、兑现未完事项或分享一件小事，不要默认责怪对方没回复。以“喂”自然开场，纯口语，不写动作或心理旁白，约80到140字，结尾自然告别。`
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
  await waitForPendingStateUpdate(sessionId);
  const msgs = await getMessages(sessionId);
  const lastUserText = [...msgs].reverse().find((msg) => msg.role === "user")?.content || "";
  const { systemPrompt } = await buildConversationContext(sessionId, userId, {
    memoryQuestion: lastUserText,
    lookupMemory: !!lastUserText,
    includeBehavior: false,
    channel: "voicemail"
  });
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
          content: `${systemPrompt}\n\n# 当前沟通方式：未接来电留言\n你刚才打电话但对方没接。留一段30到70字的口语留言，开头和结尾按角色与情境自然变化，简短说清来意，不埋怨、不写动作或心理旁白。`
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
  await waitForPendingStateUpdate(sessionId);
  const msgs = await getMessages(sessionId);
  const lastUserText = [...msgs].reverse().find((msg) => msg.role === "user")?.content || "";
  const { systemPrompt, charName } = await buildConversationContext(sessionId, userId, {
    memoryQuestion: lastUserText,
    lookupMemory: !!lastUserText,
    includeBehavior: false,
    channel: "special_call"
  });
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
          content: `${systemPrompt}\n\n# 当前沟通方式：特别来电\n来电缘由：${occasion}\n必须符合当前关系程度，不要因为节日或里程碑突然越过角色边界。以“喂”自然开头，纯口语，不写动作或心理旁白，约80到140字，最后自然告别。`
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
  let aliyunRequestId = null;
  let voiceChannel = null;
  if (char.voice_id && char.tts_enabled) {
    try {
      const ttsScript = script
        .replace(/[（(][^）)]{0,80}[）)]/g, "")
        .replace(/[【\[][^\]】]{0,80}[\]】]/g, "")
        .replace(/\*[^*]{0,80}\*/g, "")
        .replace(/\s{2,}/g, " ").trim();
      const normScript = normalizeTtsText(ttsScript);
      let ttsInput = lang === "ja" ? await translateToJapanese(normScript) : normScript;
      const ch = char.voice_channel || "cosyvoice";
      voiceChannel = ch;
      const synthFn = pickSynthFn(ch);
      const gentle = (type === "emotion" || type?.startsWith("holiday") || type === "streak");
      const moodState = getEffectiveMoodState(session);
      let callInstruction = "带电话音效果";
      const tagsEnabled = (await getGlobalSetting("tts_tags_enabled", "1")) === "1";
      const instructionEnabled = (await getGlobalSetting("tts_instruction_enabled", "1")) === "1";
      const wantTags = tagsEnabled && QWEN_AUDIO_CHANNELS.has(ch) && lang === "zh";
      const style = await generateTtsStyle(ttsInput, {
        charName: char.name,
        personality: char.personality || "",
        mood: gentle ? "soft" : moodState.mood,
        wantInstruction: instructionEnabled,
        wantTags
      }).catch(() => ({ instruction: "", tagged: ttsInput }));
      if (style.instruction) callInstruction += `，${style.instruction}`;
      if (wantTags) ttsInput = style.tagged || ttsInput;
      console.log(`[tts][特殊来电] 合成文本 ch=${ch} >>>\n${ttsInput}\n<<<`);
      const result = await synthFn(ttsInput, char.voice_id, lang, callInstruction);
      audioUrl = result.url;
      aliyunRequestId = result.aliyunRequestId || null;
    } catch (err) {
      console.error("[特殊来电] TTS 失败:", err.message);
    }
  }

  const callLogResult = await dbRun(
    "INSERT INTO call_logs (user_id, session_id, char_name, script, audio_url, answered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    [userId, sessionId, char.name, script, audioUrl || null, nowIso()]
  );
  const msgId = await appendMessage(sessionId, "assistant", `📞 [未接听] ${script}`, char.name, userId);
  if (audioUrl) {
    await dbRun(
      "UPDATE messages SET tts_audio_url = ?, tts_aliyun_request_id = ?, tts_voice_id = ?, tts_voice_channel = ? WHERE id = ?",
      [audioUrl, aliyunRequestId, char.voice_id, voiceChannel, msgId]
    );
  }
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
  // 太短的消息不足以判断情绪，直接跳过，避免「哎」「累」这类随口话误触发
  if (!text || text.trim().length < 8) return false;
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      messages: [
        {
          role: "system",
          content: "你要判断用户是否正经历**明显且强烈**的负面情绪困扰（如难过到需要安慰、遭遇打击、情绪崩溃、长期压抑倾诉）。注意：日常的随口抱怨、轻微疲惫（如「有点累」「无聊」「饿了」）、玩笑、平静叙述都**不算**。宁可漏判也不要误判，只有非常确定时才回答 yes。只回答 yes 或 no，不要解释。"
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
    "(SELECT character_name FROM messages WHERE session_id = s.id AND role = 'assistant' AND character_name IS NOT NULL ORDER BY id DESC LIMIT 1) as character_name, " +
    "(SELECT image_url FROM mood_avatars WHERE `character` = (SELECT character_name FROM messages WHERE session_id = s.id AND role = 'assistant' AND character_name IS NOT NULL ORDER BY id DESC LIMIT 1) AND (user_id = s.user_id OR user_id IS NULL) ORDER BY (mood='neutral') DESC, id DESC LIMIT 1) as character_avatar " +
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

  // ── 客户端版本中间件 ─────────────────────────────────────────────────────────
  // 解析 App UA 挂到 req.clientInfo；版本低于 app_min_version 的 App 请求拦截为 426。
  // 网页端（无 tornadoApp UA）不受影响。
  req.clientInfo = parseClientInfo(req);
  if (req.clientInfo?.isApp) {
    // 白名单：版本检查、下载、鉴权等需放行，否则旧版无法自救
    const versionExempt =
      pathname === "/app/latest-version" ||
      pathname.startsWith("/auth/") ||
      pathname === "/uploads" ||
      pathname.startsWith("/uploads/");
    if (!versionExempt) {
      const minVersion = await getGlobalSetting("app_min_version", "");
      if (minVersion && compareVersions(req.clientInfo.version, minVersion) < 0) {
        const latest = await getLatestAppVersion(req.clientInfo.os === "ios" ? "ios" : "android");
        send(res, 426, {
          error: "version_too_low",
          message: "当前版本过低，请更新后继续使用",
          min_version: minVersion,
          current_version: req.clientInfo.version,
          latest_version: latest?.version_name || null,
          download_url: latest?.download_url || null
        });
        return;
      }
    }
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
    await ensurePointAccount(userId); // 注册赠送初始小鱼干（写 signup 流水）
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
    const user = await dbGet("SELECT is_admin, avatar_url FROM users WHERE id = ?", [session.userId]);
    send(res, 200, { id: session.userId, username: session.username, is_admin: user?.is_admin ? 1 : 0, avatar_url: user?.avatar_url || null });
    return;
  }

  // GET /app/latest-version — 客户端检查最新版本（公开，无需鉴权）
  // 全部走语义化版本：latest_version 给客户端比较，min_version 与中间件用同一个阈值
  if (method === "GET" && pathname === "/app/latest-version") {
    const platform = url.searchParams.get("platform") || "android";
    const row = await getLatestAppVersion(platform);
    const minVersion = await getGlobalSetting("app_min_version", "");
    if (!row) { send(res, 200, { latest_version: null, min_version: minVersion || null }); return; }
    send(res, 200, {
      latest_version: row.version_name,
      release_notes: row.release_notes || "",
      download_url: row.download_url,
      force_update: row.force_update ? 1 : 0,
      min_version: minVersion || null
    });
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
  if (method === "GET" && (pathname === "/app.js" || pathname === "/styles.css" || pathname === "/auth.js" || pathname === "/qrcode.min.js")) {
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
  // 打开软件时弹窗：只取 popup=1 且未读
  if (method === "GET" && pathname === "/announcements/unread") {
    const rows = await dbAll(`
      SELECT a.id, a.title, a.content, a.created_at FROM announcements a
      WHERE a.popup = 1 AND a.id NOT IN (SELECT announcement_id FROM announcement_reads WHERE user_id = ?)
      ORDER BY a.created_at DESC
    `, [userId]);
    send(res, 200, rows);
    return;
  }

  // 系统通知列表：全部公告 + 每条已读状态
  if (method === "GET" && pathname === "/announcements") {
    const rows = await dbAll(`
      SELECT a.id, a.title, a.content, a.created_at, a.popup,
        (a.id IN (SELECT announcement_id FROM announcement_reads WHERE user_id = ?)) AS is_read
      FROM announcements a ORDER BY a.created_at DESC
    `, [userId]);
    send(res, 200, rows.map((r) => ({ ...r, is_read: !!r.is_read })));
    return;
  }

  // 未读数量（给红点用）
  if (method === "GET" && pathname === "/announcements/unread-count") {
    const row = await dbGet(`
      SELECT COUNT(*) AS n FROM announcements a
      WHERE a.id NOT IN (SELECT announcement_id FROM announcement_reads WHERE user_id = ?)
    `, [userId]);
    send(res, 200, { count: row?.n || 0 });
    return;
  }

  // 全部标记已读
  if (method === "POST" && pathname === "/announcements/read-all") {
    await dbRun(`
      INSERT IGNORE INTO announcement_reads (user_id, announcement_id)
      SELECT ?, id FROM announcements
    `, [userId]);
    send(res, 200, { ok: true });
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
      const popup = body.popup === undefined ? 1 : (body.popup ? 1 : 0);
      const result = await dbRun("INSERT INTO announcements (title, content, popup, created_at) VALUES (?, ?, ?, ?)", [title, content, popup, nowIso()]);
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

    // ── App 版本管理 ──────────────────────────────────────────────────────────
    // POST /admin/app-versions/upload — 上传 APK，存 OSS，返回直链
    if (method === "POST" && pathname === "/admin/app-versions/upload") {
      const MAX_APK_BYTES = 200 * 1024 * 1024;
      const declared = Number(req.headers["content-length"] || 0);
      if (declared && declared > MAX_APK_BYTES) {
        send(res, 413, { error: "安装包过大，最大 200MB" });
        return;
      }
      const chunks = [];
      let total = 0;
      let aborted = false;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_APK_BYTES) {
          aborted = true;
          try { req.destroy(); } catch {}
          break;
        }
        chunks.push(chunk);
      }
      if (aborted) { send(res, 413, { error: "安装包过大，最大 200MB" }); return; }
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) { send(res, 400, { error: "empty body" }); return; }
      const filename = `app-android-${Date.now()}.apk`;
      const url = await uploadToOss(buf, filename, "application/vnd.android.package-archive");
      send(res, 200, { url, size: buf.length });
      return;
    }

    // GET /admin/app-versions — 版本列表（按语义化版本号倒序）
    if (method === "GET" && pathname === "/admin/app-versions") {
      const rows = await dbAll("SELECT * FROM app_versions", []);
      rows.sort((a, b) => compareVersions(b.version_name, a.version_name) || (b.id - a.id));
      send(res, 200, rows);
      return;
    }

    // POST /admin/app-versions — 新建版本
    if (method === "POST" && pathname === "/admin/app-versions") {
      const body = await readBody(req);
      const platform = ["android", "ios"].includes(body.platform) ? body.platform : "android";
      const versionName = String(body.version_name || "").trim();
      const downloadUrl = String(body.download_url || "").trim();
      if (!/^\d+(\.\d+){0,2}$/.test(versionName)) { send(res, 400, { error: "版本号格式应为 x.y.z（如 0.2.0）" }); return; }
      if (!downloadUrl) { send(res, 400, { error: "下载链接不能为空（请先上传 APK 或填写外链）" }); return; }
      const releaseNotes = String(body.release_notes || "");
      const fileSize = body.file_size != null ? Math.floor(Number(body.file_size)) || null : null;
      const forceUpdate = body.force_update ? 1 : 0;
      const result = await dbRun(
        "INSERT INTO app_versions (platform, version_name, release_notes, download_url, file_size, force_update, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
        [platform, versionName, releaseNotes, downloadUrl, fileSize, forceUpdate, nowIso()]
      );
      send(res, 200, { id: Number(result.insertId) });
      return;
    }

    const adminVerMatch = pathname.match(/^\/admin\/app-versions\/(\d+)$/);
    if (method === "PATCH" && adminVerMatch) {
      const verId = Number(adminVerMatch[1]);
      const body = await readBody(req);
      if ("enabled" in body) await dbRun("UPDATE app_versions SET enabled = ? WHERE id = ?", [body.enabled ? 1 : 0, verId]);
      if ("force_update" in body) await dbRun("UPDATE app_versions SET force_update = ? WHERE id = ?", [body.force_update ? 1 : 0, verId]);
      if ("release_notes" in body) await dbRun("UPDATE app_versions SET release_notes = ? WHERE id = ?", [String(body.release_notes || ""), verId]);
      if ("download_url" in body && String(body.download_url || "").trim()) await dbRun("UPDATE app_versions SET download_url = ? WHERE id = ?", [String(body.download_url).trim(), verId]);
      send(res, 200, { ok: true });
      return;
    }

    if (method === "DELETE" && adminVerMatch) {
      const verId = Number(adminVerMatch[1]);
      await dbRun("DELETE FROM app_versions WHERE id = ?", [verId]);
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
        tts_channel: await getGlobalSetting("tts_channel", "cosyvoice"),
        tts_instruction_enabled: await getGlobalSetting("tts_instruction_enabled", "1"),
        tts_tags_enabled: await getGlobalSetting("tts_tags_enabled", "1"),
        call_min_messages: await getGlobalSetting("call_min_messages", "20"),
        call_idle_minutes: await getGlobalSetting("call_idle_minutes", "5"),
        call_cooldown_minutes: await getGlobalSetting("call_cooldown_minutes", "60"),
        call_emotion_cooldown_minutes: await getGlobalSetting("call_emotion_cooldown_minutes", "120"),
        multi_char_awareness: await getGlobalSetting("multi_char_awareness", "0"),
        app_min_version: await getGlobalSetting("app_min_version", ""),
        ...(await getAllPointConfig())
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
      if ("tts_channel" in body && TTS_CHANNELS.includes(body.tts_channel)) {
        await setGlobalSetting("tts_channel", body.tts_channel);
      }
      if ("tts_instruction_enabled" in body) {
        await setGlobalSetting("tts_instruction_enabled", body.tts_instruction_enabled ? "1" : "0");
      }
      if ("tts_tags_enabled" in body) {
        await setGlobalSetting("tts_tags_enabled", body.tts_tags_enabled ? "1" : "0");
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
      if ("app_min_version" in body) {
        // 形如 "0.2.0"，留空表示不强制
        const v = String(body.app_min_version || "").trim();
        if (v === "" || /^\d+(\.\d+){0,2}$/.test(v)) {
          await setGlobalSetting("app_min_version", v);
        }
      }
      // 积分管理配置
      if ("points_enabled" in body) {
        await setGlobalSetting("points_enabled", body.points_enabled ? "1" : "0");
      }
      for (const key of ["cost_chat", "cost_chat_voice", "cost_image", "cost_avatar", "cost_create_character", "signup_bonus", "checkin_base", "checkin_streak_bonus", "checkin_streak_cap"]) {
        if (key in body) {
          const n = Math.max(0, Math.floor(Number(body[key]) || 0));
          await setGlobalSetting(key, String(n));
        }
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
        tts_channel: await getGlobalSetting("tts_channel", "cosyvoice"),
        tts_instruction_enabled: await getGlobalSetting("tts_instruction_enabled", "1"),
        tts_tags_enabled: await getGlobalSetting("tts_tags_enabled", "1"),
        call_min_messages: await getGlobalSetting("call_min_messages", "20"),
        call_idle_minutes: await getGlobalSetting("call_idle_minutes", "5"),
        call_cooldown_minutes: await getGlobalSetting("call_cooldown_minutes", "60"),
        call_emotion_cooldown_minutes: await getGlobalSetting("call_emotion_cooldown_minutes", "120"),
        multi_char_awareness: await getGlobalSetting("multi_char_awareness", "0"),
        app_min_version: await getGlobalSetting("app_min_version", ""),
        ...(await getAllPointConfig())
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

    // GET /admin/points/user?q= — 按用户名或用户 ID 查余额 + 近期流水（兼容旧参数 username）
    if (method === "GET" && pathname === "/admin/points/user") {
      const q = String(url.searchParams.get("q") || url.searchParams.get("username") || "").trim();
      if (!q) { send(res, 400, { error: "query required" }); return; }
      // 纯数字优先按 id 查，未命中再按用户名查（兼容用数字当用户名的情况）
      let user = null;
      if (/^\d+$/.test(q)) {
        user = await dbGet("SELECT id, username FROM users WHERE id = ?", [Number(q)]);
      }
      if (!user) {
        user = await dbGet("SELECT id, username FROM users WHERE username = ?", [q]);
      }
      if (!user) { send(res, 404, { error: "user not found" }); return; }
      const balance = await getPointBalance(user.id);
      const transactions = await listTransactions(user.id, 50);
      const checkins = await listCheckins(user.id, 15);
      send(res, 200, { user_id: user.id, username: user.username, balance, transactions, checkins });
      return;
    }

    // POST /admin/points/adjust — 手动加减积分（reason=admin_adjust，写流水）
    if (method === "POST" && pathname === "/admin/points/adjust") {
      const body = await readBody(req);
      let targetUserId = Number(body.user_id) || null;
      if (!targetUserId && body.username) {
        const u = await dbGet("SELECT id FROM users WHERE username = ?", [String(body.username).trim()]);
        targetUserId = u?.id || null;
      }
      const delta = Math.floor(Number(body.delta) || 0);
      if (!targetUserId) { send(res, 400, { error: "user_id or username required" }); return; }
      if (!delta) { send(res, 400, { error: "delta required" }); return; }
      if (delta < 0) {
        // 扣减：余额不足时拒绝（避免负余额）
        const r = await spendPoints(targetUserId, -delta, "admin_adjust", null);
        if (!r.ok && !r.bypassed) { send(res, 400, { error: "balance_insufficient", balance: r.balance }); return; }
      } else {
        await grantPoints(targetUserId, delta, "admin_adjust", null);
      }
      const balance = await getPointBalance(targetUserId);
      send(res, 200, { ok: true, balance });
      return;
    }

    // GET /admin/points/transactions — 全局流水查询（可选 reason / username 过滤 + 分页）
    if (method === "GET" && pathname === "/admin/points/transactions") {
      const reason = String(url.searchParams.get("reason") || "").trim();
      const username = String(url.searchParams.get("username") || "").trim();
      const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get("limit")) || 50)));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
      const where = [];
      const params = [];
      if (reason) { where.push("t.reason = ?"); params.push(reason); }
      if (username) { where.push("u.username = ?"); params.push(username); }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = await dbAll(
        `SELECT t.id, t.user_id, u.username, t.delta, t.balance_after, t.reason, t.ref, t.created_at
         FROM point_transactions t LEFT JOIN users u ON u.id = t.user_id
         ${whereSql} ORDER BY t.id DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      send(res, 200, { rows, limit, offset });
      return;
    }

    // GET /admin/points/checkins — 全局签到记录查询（可选 username 过滤 + 分页）
    if (method === "GET" && pathname === "/admin/points/checkins") {
      const username = String(url.searchParams.get("username") || "").trim();
      const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get("limit")) || 50)));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
      const where = [];
      const params = [];
      if (username) { where.push("u.username = ?"); params.push(username); }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = await dbAll(
        `SELECT c.id, c.user_id, u.username, c.checkin_date, c.points, c.streak, c.created_at
         FROM daily_checkins c LEFT JOIN users u ON u.id = c.user_id
         ${whereSql} ORDER BY c.id DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      send(res, 200, { rows, limit, offset });
      return;
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
    const relationship = getRelationshipState(char);
    send(res, 200, {
      id: char?.id || null,
      name,
      card_url: cardUrl,
      slideshow_enabled: char?.slideshow_enabled === 1,
      slideshow_interval: char?.slideshow_interval ?? 30,
      affection: relationship.affection,
      relationship: {
        trust: relationship.trust,
        warmth: relationship.warmth,
        intimacy: relationship.intimacy,
        tension: relationship.tension
      }
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
    const points = { enabled: await pointsEnabled(), balance: await getPointBalance(userId), cost_avatar: await getPointConfig("cost_avatar") };
    send(res, 200, { character: name, avatars, stale, moods: Object.keys(MOOD_AVATAR_PROMPTS), quota, points });
    return;
  }

  // POST /avatars/regenerate — 一键重置：删除全部头像 + 重新生成（按张数 × cost_avatar 扣）
  if (method === "POST" && pathname === "/avatars/regenerate") {
    const name = await getCharacterName(userId);
    if (!name) { send(res, 400, { error: "no character" }); return; }
    const moods = Object.keys(MOOD_AVATAR_PROMPTS);
    const avatarCost = await getPointConfig("cost_avatar");
    const totalCost = avatarCost * moods.length;
    const spendRes = await spendPoints(userId, totalCost, "avatar", `regen_all:${name}`);
    if (!spendRes.ok) {
      send(res, 402, { error: "points_insufficient", need: totalCost, balance: spendRes.balance });
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
    const avatarCost = await getPointConfig("cost_avatar");
    const spendRes = await spendPoints(userId, avatarCost, "avatar", `regen:${name}:${mood}`);
    if (!spendRes.ok) {
      send(res, 402, { error: "points_insufficient", need: avatarCost, balance: spendRes.balance });
      return;
    }
    await dbRun("DELETE FROM mood_avatars WHERE `character` = ? AND mood = ? AND (user_id = ? OR user_id IS NULL)", [name, mood, userId]);
    generateMoodAvatar(mood, userId).then(async (url) => {
      if (url) {
        pushToUser(userId, { mood_avatar_update: true, mood, avatar_url: url });
      } else {
        await refundPoints(userId, avatarCost, "refund_avatar", `regen:${name}:${mood}:${Date.now()}`);
        pushToUser(userId, { points_refunded: true, amount: avatarCost });
      }
    }).catch(async () => {
      await refundPoints(userId, avatarCost, "refund_avatar", `regen:${name}:${mood}:${Date.now()}`);
      pushToUser(userId, { points_refunded: true, amount: avatarCost });
    });
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
    const imageCost = await getPointConfig("cost_image");
    const spendRes = await spendPoints(userId, imageCost, "image", "card");
    if (!spendRes.ok) {
      send(res, 402, { error: "points_insufficient", need: imageCost, balance: spendRes.balance });
      return;
    }
    send(res, 202, { ok: true, message: "生成中" });
    generateCharacterCard(true, userId).then(async (url) => {
      if (url) {
        pushToUser(userId, { card_update: true, card_url: url });
      } else {
        // 生成失败 → 退款
        await refundPoints(userId, imageCost, "refund_image", `card:${Date.now()}`);
        pushToUser(userId, { points_refunded: true, amount: imageCost });
      }
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
    await dbRun("UPDATE characters SET affection = ?, trust_score = NULL, warmth_score = NULL, intimacy_score = NULL, tension_score = NULL WHERE id = ?", [value, char.id]);
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
        send(res, 200, { soul: fileSoul || "", character_id: null, name: "", appearance: "", personality: "", description: "", values_content: "", boundaries_content: "", habits_content: "", speech_examples: "" });
        return;
      }
      send(res, 200, {
        character_id: char.id,
        name: char.name || "",
        appearance: char.appearance || "",
        personality: char.personality || "",
        description: char.description || "",
        values_content: char.values_content || "",
        boundaries_content: char.boundaries_content || "",
        habits_content: char.habits_content || "",
        speech_examples: char.speech_examples || "",
        soul: char.soul_content || "",
        reference_image_url: char.reference_image_url || null
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
    if (typeof body.values_content === "string") await dbRun("UPDATE characters SET values_content = ? WHERE id = ?", [body.values_content.trim(), char.id]);
    if (typeof body.boundaries_content === "string") await dbRun("UPDATE characters SET boundaries_content = ? WHERE id = ?", [body.boundaries_content.trim(), char.id]);
    if (typeof body.habits_content === "string") await dbRun("UPDATE characters SET habits_content = ? WHERE id = ?", [body.habits_content.trim(), char.id]);
    if (typeof body.speech_examples === "string") await dbRun("UPDATE characters SET speech_examples = ? WHERE id = ?", [body.speech_examples.trim(), char.id]);
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
    if (!char) { send(res, 200, { voice_id: null, tts_enabled: 0, voice_channel: "cosyvoice" }); return; }
    send(res, 200, { voice_id: char.voice_id || null, tts_enabled: char.tts_enabled || 0, voice_channel: char.voice_channel || "cosyvoice" });
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
    const channel = await getGlobalSetting("tts_channel", "cosyvoice");
    const filename = `voice-sample-${char.id}-${Date.now()}${ext}`;
    const ossUrl = await uploadToOss(buf, filename);
    const voiceId = await pickCloneVoiceFn(channel)(ossUrl, char.id);
    // 若已有旧音色，异步删除
    if (char.voice_id) {
      const oldChannel = char.voice_channel || "cosyvoice";
      pickDeleteVoiceFn(oldChannel)(char.voice_id).catch(() => {});
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
      const ch = char.voice_channel || "cosyvoice";
      pickDeleteVoiceFn(ch)(char.voice_id).catch(() => {});
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
      const synthFn = pickSynthFn(char.voice_channel || "cosyvoice");
      console.log(`[tts][预览] 合成文本 ch=${char.voice_channel || "cosyvoice"} >>>\n${text}\n<<<`);
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
      "SELECT c.id, c.name, c.appearance, c.personality, c.description, c.values_content, c.boundaries_content, c.habits_content, c.speech_examples, c.soul_content, c.is_active, c.created_at, " +
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
    const row = await dbGet("SELECT id, name, appearance, personality, description, values_content, boundaries_content, habits_content, speech_examples, soul_content, reference_image_url, is_active, created_at FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
    if (!row) { send(res, 404, { error: "not found" }); return; }
    send(res, 200, row);
    return;
  }

  // POST /characters — 新建角色
  if (method === "POST" && pathname === "/characters") {
    const body = await readBody(req);
    if (!body.name?.trim()) { send(res, 400, { error: "name required" }); return; }
    // 创建角色扣费（已含首次卡片+全部情绪头像生成，激活时触发，不再额外扣图片费）
    const createCost = await getPointConfig("cost_create_character");
    const spendRes = await spendPoints(userId, createCost, "create_character", null);
    if (!spendRes.ok) {
      send(res, 402, { error: "points_insufficient", need: createCost, balance: spendRes.balance });
      return;
    }
    const soul = body.soul_content || `# 角色名称\n\n${body.name.trim()}\n\n# 外貌\n\n# 性格\n\n# 说话方式\n\n`;
    let result;
    try {
      result = await dbRun(
        "INSERT INTO characters (name, appearance, personality, description, values_content, boundaries_content, habits_content, speech_examples, soul_content, is_active, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        [body.name.trim(), body.appearance || "", body.personality || "", body.description || "", body.values_content || "", body.boundaries_content || "", body.habits_content || "", body.speech_examples || "", soul, nowIso(), userId]
      );
    } catch (e) {
      // 写入失败（如重名）→ 退还创建费
      await refundPoints(userId, createCost, "refund_create_character", `create:${Date.now()}`);
      send(res, 400, { error: e.code === "ER_DUP_ENTRY" ? "角色名已存在" : "创建失败" });
      return;
    }
    // 标记本角色的卡片/头像生成在 cost_create_character 内已含，激活时不再扣图片费
    // （激活走 pregenerateMoodAvatars / generateCharacterCard，这两个内部函数本就不扣费）
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
    if (typeof body.values_content === "string") await dbRun("UPDATE characters SET values_content = ? WHERE id = ? AND user_id = ?", [body.values_content.trim(), charId, userId]);
    if (typeof body.boundaries_content === "string") await dbRun("UPDATE characters SET boundaries_content = ? WHERE id = ? AND user_id = ?", [body.boundaries_content.trim(), charId, userId]);
    if (typeof body.habits_content === "string") await dbRun("UPDATE characters SET habits_content = ? WHERE id = ? AND user_id = ?", [body.habits_content.trim(), charId, userId]);
    if (typeof body.speech_examples === "string") await dbRun("UPDATE characters SET speech_examples = ? WHERE id = ? AND user_id = ?", [body.speech_examples.trim(), charId, userId]);
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

  // POST /characters/:id/reference-image — 上传角色参考图（二进制流 → OSS → 写 characters.reference_image_url）
  // 后续该角色的所有生图都会以此图做图生图，保持形象统一
  const charRefImgMatch = pathname.match(/^\/characters\/(\d+)\/reference-image$/);
  if (method === "POST" && charRefImgMatch) {
    const charId = Number(charRefImgMatch[1]);
    const char = await dbGet("SELECT id FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
    if (!char) { send(res, 404, { error: "not found" }); return; }
    const MAX_REF_BYTES = 10 * 1024 * 1024;
    const declared = Number(req.headers["content-length"] || 0);
    if (declared && declared > MAX_REF_BYTES) {
      send(res, 413, { error: "图片过大，最大 10MB" });
      return;
    }
    const chunks = [];
    let total = 0;
    let aborted = false;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_REF_BYTES) { aborted = true; try { req.destroy(); } catch {} break; }
      chunks.push(chunk);
    }
    if (aborted) { send(res, 413, { error: "图片过大，最大 10MB" }); return; }
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) { send(res, 400, { error: "empty body" }); return; }
    const ext = (req.headers["content-type"] || "").includes("png") ? ".png" : ".jpg";
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    const filename = `char-ref-${userId}-${charId}-${Date.now()}${ext}`;
    let refUrl;
    try {
      refUrl = await uploadToOss(buf, filename, mimeType);
    } catch (err) {
      console.error(`[char-ref] OSS 上传失败: ${err.message}`);
      send(res, 500, { error: "上传失败" });
      return;
    }
    await dbRun("UPDATE characters SET reference_image_url = ? WHERE id = ? AND user_id = ?", [refUrl, charId, userId]);
    send(res, 200, { ok: true, reference_image_url: refUrl });
    return;
  }

  // DELETE /characters/:id/reference-image — 清除角色参考图
  if (method === "DELETE" && charRefImgMatch) {
    const charId = Number(charRefImgMatch[1]);
    const char = await dbGet("SELECT id FROM characters WHERE id = ? AND user_id = ?", [charId, userId]);
    if (!char) { send(res, 404, { error: "not found" }); return; }
    await dbRun("UPDATE characters SET reference_image_url = NULL WHERE id = ? AND user_id = ?", [charId, userId]);
    send(res, 200, { ok: true });
    return;
  }

  // POST /user/avatar — 上传用户头像（二进制流 → OSS → 写 users.avatar_url）
  if (method === "POST" && pathname === "/user/avatar") {
    const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
    const declared = Number(req.headers["content-length"] || 0);
    if (declared && declared > MAX_AVATAR_BYTES) {
      send(res, 413, { error: "图片过大，最大 10MB" });
      return;
    }
    const chunks = [];
    let total = 0;
    let aborted = false;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_AVATAR_BYTES) { aborted = true; try { req.destroy(); } catch {} break; }
      chunks.push(chunk);
    }
    if (aborted) { send(res, 413, { error: "图片过大，最大 10MB" }); return; }
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) { send(res, 400, { error: "empty body" }); return; }
    const ext = (req.headers["content-type"] || "").includes("png") ? ".png" : ".jpg";
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    const filename = `user-avatar-${userId}-${Date.now()}${ext}`;
    let avatarUrl;
    try {
      avatarUrl = await uploadToOss(buf, filename, mimeType);
    } catch (err) {
      console.error(`[user-avatar] OSS 上传失败: ${err.message}`);
      send(res, 500, { error: "上传失败" });
      return;
    }
    await dbRun("UPDATE users SET avatar_url = ? WHERE id = ?", [avatarUrl, userId]);
    send(res, 200, { ok: true, avatar_url: avatarUrl });
    return;
  }

  // DELETE /user/avatar — 清除用户头像
  if (method === "DELETE" && pathname === "/user/avatar") {
    await dbRun("UPDATE users SET avatar_url = NULL WHERE id = ?", [userId]);
    send(res, 200, { ok: true });
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

    // 小鱼干扣费（取代每日张数上限）：提交成功即扣，异步失败退款
    const imageCost = await getPointConfig("cost_image");
    const spendRes = await spendPoints(userId, imageCost, "image", `session:${sessionId}`);
    if (!spendRes.ok) {
      send(res, 402, { error: "points_insufficient", need: imageCost, balance: spendRes.balance });
      return;
    }

    const settings = await getUserSettings(userId);
    const imageFallbackEnabled = settings.imageFallbackEnabled;
    // 找最近一条 assistant 消息作为场景依据
    const lastAssist = await dbGet("SELECT id, content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [sessionId]);
    if (!lastAssist) {
      await refundPoints(userId, imageCost, "refund_image", `session:${sessionId}:noassist:${Date.now()}`);
      send(res, 400, { error: "no assistant message" });
      return;
    }
    const recentMsgs = await dbAll("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10", [sessionId]);
    recentMsgs.reverse();
    const previousScene = await getLastImagePrompt(sessionId);
    const prompt = await generateImagePrompt("", lastAssist.content, recentMsgs, previousScene, userId);
    // 手动插图：始终新建一条独立的空消息承载插图（不附到上一条回复气泡上）
    // character_name 必须带上，否则画廊按角色过滤时查不到这条插图
    const targetMsgId = await appendMessage(sessionId, "assistant", "", await getCharacterName(userId), userId);
    pushToSession(sessionId, { image_pending: true, msg_id: targetMsgId });
    const reqAspect = url.searchParams.get("aspect") || "";
    const aspect = ["1:1", "2:3", "9:16", "16:9"].includes(reqAspect) ? reqAspect : null;
    fireImageGeneration(targetMsgId, prompt, sessionId, { silent: false, imageFallbackEnabled, userId, aspectRatio: aspect, refund: { amount: imageCost, reason: "refund_image", ref: `msg:${targetMsgId}` } });
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

  // GET /sessions/:id/messages — 支持游标分页：?limit=N&before_id=ID（取该 id 之前的更早消息）
  // 不带 limit 时返回全部（兼容旧调用）。带 limit 时返回 { items, hasMore }，items 按 id 升序。
  const msgsMatch = pathname.match(/^\/sessions\/(\d+)\/messages$/);
  if (method === "GET" && msgsMatch) {
    const id = Number(msgsMatch[1]);
    const limitParam = url.searchParams.get("limit");
    if (!limitParam) {
      send(res, 200, await getMessages(id));
      return;
    }
    const limit = Math.min(100, Math.max(1, Number(limitParam) || 30));
    const beforeId = Number(url.searchParams.get("before_id") || 0);
    const fetchN = limit + 1; // 已是清洗过的整数，内联进 SQL（mysql2 的 LIMIT 不支持占位符）
    let rows;
    if (beforeId > 0) {
      rows = await dbAll(
        `SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ${fetchN}`,
        [id, beforeId]
      );
    } else {
      rows = await dbAll(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ${fetchN}`,
        [id]
      );
    }
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).reverse(); // 升序返回，前端拼接更直观
    send(res, 200, { items, hasMore });
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
    // 上一轮的情绪/关系更新若仍在进行，先等它落库，避免快速连续发送时状态错一拍。
    await waitForPendingStateUpdate(sessionId);

    const body = await readBody(req);
    const userText = String(body.message || "").trim();
    if (!userText) {
      send(res, 400, { error: "missing message" });
      return;
    }

    // ── 小鱼干扣费预校验：成功落库后才扣，但开扣前先确认余额够，不够直接拒绝（不发起 LLM、不存用户消息）──
    const ttsChar = await getActiveCharacter(userId);
    const ttsSettings = await getUserSettings(userId);
    const willVoice = !!(ttsSettings.ttsEnabled && ttsChar?.voice_id);
    const chatCost = willVoice ? await getPointConfig("cost_chat_voice") : await getPointConfig("cost_chat");
    const chatReason = willVoice ? "chat_voice" : "chat";
    if (await pointsEnabled()) {
      const bal = await getPointBalance(userId);
      if (bal < chatCost) {
        send(res, 402, { error: "points_insufficient", need: chatCost, balance: bal });
        return;
      }
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

    // 组装上下文：只带最近的对话，让旧话题自然淡出（长期记忆由记忆系统/实体图谱/日记承接）
    const CONTEXT_WINDOW = 30;
    const recent = allMsgs.slice(-CONTEXT_WINDOW);

    // 按需查询与当前消息相关的记忆，并通过统一构建器装配角色状态。
    const shouldLookup = await needsMemoryLookup(userText, recent);
    const conversationContext = await buildConversationContext(sessionId, userId, {
      memoryQuestion: userText,
      lookupMemory: shouldLookup
    });
    const {
      systemPrompt,
      char,
      charName,
      previousScene,
      relationship,
      moodState,
      memoryContext,
      entityGraph,
      diary,
      behaviorHint
    } = conversationContext;
    const affection = relationship.affection;
    const mood = moodState.mood;
    if (shouldLookup) console.log(`[memory] 查询完成，${memoryContext ? "有记忆" : "无相关记忆"}`);
    if (entityGraph) console.log(`[memory] 实体图谱已加载，${entityGraph.split("\n").length} 条关系`);
    if (diary) console.log(`[diary] 注入日记: ${diary.slice(0, 40)}...`);
    if (behaviorHint) console.log(`[behavior] ${behaviorHint}`);

    // 情绪低落检测：好感度 > 60 时，先判断是否触发来电，若触发则跳过 LLM 回复
    if ((affection ?? 0) > 60) {
      const emotionCooldownMs = Number(await getGlobalSetting("call_emotion_cooldown_minutes", "120")) * 60000;
      const sessionForEmotion = await getSession(sessionId);
      const lastEmotionCallAt = sessionForEmotion?.last_emotion_call_at;
      const cooldownOk = !lastEmotionCallAt || Date.now() - new Date(lastEmotionCallAt).getTime() >= emotionCooldownMs;
      if (cooldownOk) {
        const isLow = await detectLowMood(userText);
        if (isLow) {
          await dbRun("UPDATE sessions SET last_emotion_call_at = ? WHERE id = ?", [nowIso(), sessionId]);
          console.log(`[情绪来电] user=${userId} affection=${affection} 触发安慰来电`);
          // 跳过 LLM 回复，直接触发来电
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
          res.write(`data: ${JSON.stringify({ done: true, msg_id: null, user_msg_id: Number(userMsgId), skip_reply: true })}\n\n`);
          res.end();
          triggerSpecialCall(sessionId, userId, "emotion", null, { skipSessionCooldown: true }).catch((e) => console.error("[情绪来电] 触发失败:", e.message));
          return;
        }
      }
    }

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

    // 回复已落库 → 扣聊天费（带语音按 cost_chat_voice，否则 cost_chat；总开关关时旁路）
    await spendPoints(userId, chatCost, chatReason, `session:${sessionId}`);

    // 通知前端文字完成，附带图片状态
    const donePayload = { done: true, msg_id: Number(msgId), user_msg_id: Number(userMsgId) };
    let imgAllowed = false;
    const imageCost = await getPointConfig("cost_image");
    if (imgPrompt) {
      // 聊天内嵌自动插图额外按 cost_image 扣；余额不足则跳过插图（不影响文字回复）
      const r = await spendPoints(userId, imageCost, "image", `msg:${msgId}`);
      imgAllowed = r.ok;
      if (imgAllowed) {
        donePayload.image_pending = true;
        donePayload.image_silent = imgSilent;
      } else {
        console.log(`[自动插图] 用户 ${userId} 小鱼干不足，跳过插图`);
      }
    }

    res.write(`data: ${JSON.stringify(donePayload)}\n\n`);

    if (imgPrompt && imgAllowed) {
      fireImageGeneration(Number(msgId), imgPrompt, sessionId, { silent: imgSilent, previousScene, imageFallbackEnabled: ttsSettings.imageFallbackEnabled, userId, refund: { amount: imageCost, reason: "refund_image", ref: `msg:${msgId}` } });
    }

    // 异步更新情绪和话题摘要（不阻塞响应）
    const updatedMsgs = await getMessages(sessionId);
    const moodUpdatePromise = updateMood(sessionId, updatedMsgs, userId, Number(msgId));
    const stateTasks = [moodUpdatePromise];
    // 每 6 轮更新一次话题摘要
    const userMsgCount = updatedMsgs.filter((m) => m.role === "user").length;
    if (userMsgCount % 6 === 0 || userMsgCount <= 2) {
      updateTopicSummary(sessionId, updatedMsgs, userId).catch(() => {});
    }
    // 每 N 轮更新一次心动值
    const affectionInterval = Number(await getGlobalSetting("affection_interval", "3")) || 3;
    if (userMsgCount % affectionInterval === 0 && userMsgCount > 0) {
      stateTasks.push(updateAffection(sessionId, updatedMsgs, userId).catch((e) => console.error("[affection] 调用失败:", e.message)));
    }
    trackSessionStateUpdate(sessionId, Promise.allSettled(stateTasks));
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
          let ttsInput = normalizeTtsText(stripped);
          if (lang === "ja") ttsInput = await translateToJapanese(ttsInput);
          const ch = ttsChar.voice_channel || "cosyvoice";
          // instruction 与标签为两个独立开关；标签仅 qwen-audio 中文渠道有效
          const instructionEnabled = (await getGlobalSetting("tts_instruction_enabled", "1")) === "1";
          const tagsEnabled = (await getGlobalSetting("tts_tags_enabled", "1")) === "1";
          const wantTags = tagsEnabled && QWEN_AUDIO_CHANNELS.has(ch) && lang === "zh";
          // 一次 LLM 调用同时产出 instruction 和标签，保证两者情绪一致，避免音色漂移
          let instruction = "";
          if (instructionEnabled || wantTags) {
            const replyMood = await moodUpdatePromise.catch(() => mood);
            const style = await generateTtsStyle(ttsInput, {
              charName: char?.name || "", personality: char?.personality || "", mood: replyMood,
              wantInstruction: instructionEnabled, wantTags
            }).catch(() => ({ instruction: "", tagged: ttsInput }));
            instruction = style.instruction || "";
            if (wantTags) ttsInput = style.tagged || ttsInput;
          }
          // 客户端声明不支持流式 PCM（如 RN App）时不推 chunk，直接等最终音频
          const allowStreamTts = req.headers["x-stream-tts"] !== "0";
          console.log(`[tts] 开始合成 lang=${lang} ch=${ch} chars=${ttsInput.length} instruction="${instruction}"`);
          console.log(`[tts] 合成文本 >>>\n${ttsInput}\n<<<`);
          let audioUrl;
          let aliyunRequestId = null;
          if (ch === "cosyvoice" && allowStreamTts) {
            // 流式：边合成边推 PCM chunk
            pushToUser(userId, { tts_stream_start: true, msg_id: Number(msgId) });
            const result = await synthesizeSpeechCosyVoice(
              ttsInput, ttsChar.voice_id, lang, instruction,
              (chunk) => pushToUser(userId, { tts_chunk: true, msg_id: Number(msgId), data: chunk.toString("base64") })
            );
            audioUrl = result.url;
            aliyunRequestId = result.aliyunRequestId || null;
            await dbRun(
              "UPDATE messages SET tts_audio_url = ?, tts_aliyun_request_id = ?, tts_voice_id = ?, tts_voice_channel = ? WHERE id = ?",
              [audioUrl, aliyunRequestId, ttsChar.voice_id, ch, msgId]
            );
            pushToUser(userId, { tts_stream_end: true, msg_id: Number(msgId), audio_url: audioUrl });
          } else {
            // 非流式：cosyvoice 不传 onChunk 回调即等最终 wav；qwen-audio 走 HTTP
            const result = await pickSynthFn(ch)(ttsInput, ttsChar.voice_id, lang, instruction);
            audioUrl = result.url;
            aliyunRequestId = result.aliyunRequestId || null;
            await dbRun(
              "UPDATE messages SET tts_audio_url = ?, tts_aliyun_request_id = ?, tts_voice_id = ?, tts_voice_channel = ? WHERE id = ?",
              [audioUrl, aliyunRequestId, ttsChar.voice_id, ch, msgId]
            );
            pushToUser(userId, { tts: true, msg_id: Number(msgId), audio_url: audioUrl });
          }
          console.log(`[tts] 合成完成 aliyun_request_id=${aliyunRequestId || "无"} url=${audioUrl}`);
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

  // POST /messages/delete-batch — 批量删除消息（画廊批量删图用，限本人会话）
  if (method === "POST" && pathname === "/messages/delete-batch") {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (ids.length === 0) { send(res, 400, { error: "ids required" }); return; }
    const placeholders = ids.map(() => "?").join(",");
    // 只删属于当前用户会话的消息
    const result = await dbRun(
      `DELETE m FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id IN (${placeholders}) AND s.user_id = ?`,
      [...ids, userId]
    );
    send(res, 200, { ok: true, deleted: result.affectedRows ?? 0 });
    return;
  }

  // POST /messages/:id/tts-feedback — 记录语音体验反馈（限本人会话的语音消息）
  const ttsFeedbackMatch = pathname.match(/^\/messages\/(\d+)\/tts-feedback$/);
  if (method === "POST" && ttsFeedbackMatch) {
    const msgId = Number(ttsFeedbackMatch[1]);
    const body = await readBody(req);
    const rating = body.rating;
    if (!['good', 'bad'].includes(rating)) {
      send(res, 400, { error: "rating must be good or bad" });
      return;
    }
    const msg = await dbGet(
      `SELECT m.id, m.session_id, m.content, m.tts_audio_url, m.tts_aliyun_request_id,
              m.tts_voice_id, m.tts_voice_channel
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE m.id = ? AND m.role = 'assistant' AND m.tts_audio_url IS NOT NULL AND s.user_id = ?`,
      [msgId, userId]
    );
    if (!msg) {
      send(res, 404, { error: "voice message not found" });
      return;
    }
    const createdAt = nowIso();
    const result = await dbRun(
      `INSERT INTO tts_feedback_logs
       (user_id, message_id, session_id, rating, aliyun_request_id, voice_id, voice_channel, audio_url, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, msg.id, msg.session_id, rating, msg.tts_aliyun_request_id, msg.tts_voice_id,
        msg.tts_voice_channel, msg.tts_audio_url, msg.content, createdAt]
    );
    const ratingText = rating === "good" ? "好" : "坏";
    console.log(
      `[tts-feedback] 语音体验=${ratingText} 【aliyun_request_id】:${msg.tts_aliyun_request_id || "无"}` +
      ` message_id=${msg.id} user_id=${userId} voice_id=${msg.tts_voice_id || "无"}` +
      ` voice_channel=${msg.tts_voice_channel || "无"} audio_url=${msg.tts_audio_url}`
    );
    send(res, 201, { ok: true, feedback_id: Number(result.insertId) });
    return;
  }

  // POST /messages/:id/favorite — 收藏 / 取消收藏（限本人会话的消息）
  const favMatch = pathname.match(/^\/messages\/(\d+)\/favorite$/);
  if ((method === "POST" || method === "DELETE") && favMatch) {
    const msgId = Number(favMatch[1]);
    const own = await dbGet(
      "SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ? AND s.user_id = ?",
      [msgId, userId]
    );
    if (!own) { send(res, 404, { error: "message not found" }); return; }
    if (method === "POST") {
      await dbRun("UPDATE messages SET favorited = 1, favorited_at = ? WHERE id = ?", [nowIso(), msgId]);
      send(res, 200, { ok: true, favorited: 1 });
    } else {
      await dbRun("UPDATE messages SET favorited = 0, favorited_at = NULL WHERE id = ?", [msgId]);
      send(res, 200, { ok: true, favorited: 0 });
    }
    return;
  }

  // GET /favorites?character=NAME — 收藏的消息列表（仅角色回复，按收藏时间倒序）
  if (method === "GET" && pathname === "/favorites") {
    const character = url.searchParams.get("character") || null;
    let rows;
    if (character) {
      rows = await dbAll(
        `SELECT m.id, m.session_id, m.content, m.image_url, m.character_name, m.created_at, m.favorited_at, m.tts_audio_url, m.mood, s.title
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE m.favorited = 1 AND m.role = 'assistant' AND m.character_name = ? AND s.user_id = ?
         ORDER BY m.favorited_at DESC, m.id DESC`,
        [character, userId]
      );
    } else {
      rows = await dbAll(
        `SELECT m.id, m.session_id, m.content, m.image_url, m.character_name, m.created_at, m.favorited_at, m.tts_audio_url, m.mood, s.title
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE m.favorited = 1 AND m.role = 'assistant' AND s.user_id = ?
         ORDER BY m.favorited_at DESC, m.id DESC`,
        [userId]
      );
    }
    send(res, 200, rows);
    return;
  }


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

  // ── 小鱼干（积分）用户侧接口 ──
  // GET /points — 当前余额
  if (method === "GET" && pathname === "/points") {
    const balance = await getPointBalance(userId);
    send(res, 200, { balance, enabled: await pointsEnabled() });
    return;
  }

  // GET /points/transactions?limit=N — 流水列表
  if (method === "GET" && pathname === "/points/transactions") {
    const limit = Number(url.searchParams.get("limit")) || 50;
    const rows = await listTransactions(userId, limit);
    send(res, 200, rows);
    return;
  }

  // GET /checkin/status — 今日是否已签、连续天数、今日预计奖励、签到记录
  // 可选 ?month=YYYY-MM 查询某自然月的全部记录；不带则返回最近 30 条
  if (method === "GET" && pathname === "/checkin/status") {
    const status = await getCheckinStatus(userId);
    const month = url.searchParams.get("month");
    const history = month
      ? (await listCheckinsByMonth(userId, month)) ?? await listCheckins(userId, 30)
      : await listCheckins(userId, 30);
    const balance = await getPointBalance(userId);
    send(res, 200, { ...status, balance, history });
    return;
  }

  // POST /checkin — 执行签到
  if (method === "POST" && pathname === "/checkin") {
    const r = await doCheckin(userId);
    if (!r.ok) {
      send(res, 400, { error: "already_checked_in" });
      return;
    }
    send(res, 200, r);
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
    const sessionUserId = session.user_id ?? null;
    // 主动消息扣费（§9.4）：余额不足时跳过该次主动消息（不发送、不扣、不报错）
    const proactiveCost = await getPointConfig("cost_chat");
    if (await pointsEnabled() && sessionUserId) {
      const bal = await getPointBalance(sessionUserId);
      if (bal < proactiveCost) {
        console.log(`[主动消息] 用户 ${sessionUserId} 小鱼干不足，跳过本次主动消息`);
        continue;
      }
    }
    console.log(`主动发消息 [session ${session.id}]，已空闲 ${Math.round(idleMs / 60000)} 分钟`);
    // 记录本次主动发消息时间，防止用户未回复时重复触发
    await dbRun("UPDATE sessions SET last_proactive_at = ? WHERE id = ?", [nowIso(), session.id]);
    const text = await generateProactiveMessage(session.id, sessionUserId).catch(() => null);
    if (!text) continue;
    const { cleanText, prompt: imgPrompt } = extractImageTag(text);
    const msgId = await appendMessage(session.id, "assistant", cleanText, await getCharacterName(sessionUserId), sessionUserId);
    // 主动消息落库成功 → 扣聊天费
    await spendPoints(sessionUserId, proactiveCost, "chat", `proactive:${session.id}`);
    const payload = { proactive: true, msg_id: Number(msgId), text: cleanText };
    if (imgPrompt) {
      const previousScene = await getLastImagePrompt(session.id);
      const imageCost = await getPointConfig("cost_image");
      const r = await spendPoints(sessionUserId, imageCost, "image", `msg:${msgId}`);
      if (r.ok) {
        payload.image_pending = true;
        fireImageGeneration(Number(msgId), imgPrompt, session.id, { silent: true, previousScene, userId: sessionUserId, refund: { amount: imageCost, reason: "refund_image", ref: `msg:${msgId}` } });
      } else {
        console.log(`[主动插图] 用户 ${sessionUserId} 小鱼干不足，跳过插图`);
      }
    }
    pushToSession(session.id, payload);
    const updatedMsgs = await getMessages(session.id);
    trackSessionStateUpdate(
      session.id,
      Promise.allSettled([updateMood(session.id, updatedMsgs, sessionUserId, Number(msgId))])
    );
  }

  // ── 日记生成：空闲 > 2 小时，且自上次日记以来新增 ≥ 50 条聊天的 session ──
  const DIARY_IDLE_MS = 2 * 60 * 60 * 1000;
  const DIARY_MIN_NEW_MESSAGES = 50;
  const allSessions = await listAllActiveSessions();
  for (const session of allSessions) {
    if (!session.last_user_at) continue;
    const idleMs = Date.now() - new Date(session.last_user_at).getTime();
    if (idleMs < DIARY_IDLE_MS) continue;
    const sessionUserId = session.user_id ?? null;
    if (!sessionUserId) continue;
    const msgs = await getMessages(session.id);
    const newMsgs = session.last_diary_message_id
      ? msgs.filter((msg) => Number(msg.id) > Number(session.last_diary_message_id))
      : msgs;
    // 每 50 条聊天才更新一次日记（不计 system 消息）
    if (newMsgs.filter(m => m.role !== "system").length < DIARY_MIN_NEW_MESSAGES) continue;
    const char = await getActiveCharacter(sessionUserId);
    if (!char) continue;
    const charName = char.name || "default";
    const latestMessageId = newMsgs[newMsgs.length - 1]?.id || null;
    console.log(`[diary] 生成日记 session=${session.id} user=${sessionUserId} char=${charName}`);
    const diary = await generateDiary(session.id, sessionUserId).catch(() => null);
    if (!diary) {
      // 生成失败也推进水位线，避免每 2 分钟对同一批 session 空转重试
      if (latestMessageId) {
        await dbRun("UPDATE sessions SET last_diary_message_id = ? WHERE id = ?", [latestMessageId, session.id]);
      }
      continue;
    }
    await dbRun(
      "INSERT INTO character_diaries (user_id, character_id, session_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
      [sessionUserId, char.id, session.id, diary, nowIso()]
    );
    await dbRun("UPDATE sessions SET diary_generated = 1, last_diary_message_id = ? WHERE id = ?", [latestMessageId, session.id]);
    const memoryLines = newMsgs.slice(-24).map((msg) => `${msg.role === "user" ? "用户" : charName}：${msg.content}`);
    ingestToMemory(`[近期对话片段]\n${memoryLines.join("\n")}\n\n[${charName}的内心独白]\n${diary}`, charName, sessionUserId);
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
    if (!lastUserAt) continue;

    const idleMs = now - new Date(lastUserAt).getTime();
    if (idleMs < callIdleMs) continue;

    // 冷却期
    if (session.last_call_at && (now - new Date(session.last_call_at).getTime()) < callCooldownMs) continue;

    // 今日该角色对话中的用户消息数
    const todayMsgs = await dbGet(`
      SELECT COUNT(*) as n FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE s.user_id = ? AND m.role = 'user' AND m.created_at LIKE ?
        AND EXISTS (SELECT 1 FROM messages WHERE session_id = m.session_id AND role = 'assistant' AND character_name = ?)
    `, [userId, `${today}%`, char.name]);
    if ((todayMsgs?.n || 0) < callMinMessages) continue;

      console.log(`[来电] user=${userId} char=${char.name} session=${session.id} reason=空闲 今日消息=${todayMsgs.n} 空闲=${Math.round(idleMs / 60000)}分钟 tts=${char.tts_enabled ? "on" : "off"}`);
      await dbRun("UPDATE sessions SET last_call_at = ? WHERE id = ?", [nowIso(), session.id]);

      const script = await generateCallScript(session.id, userId).catch(() => null);
      if (!script) continue;

      let audioUrl = null;
      let aliyunRequestId = null;
      let voiceChannel = null;
      const ttsSettings = await getUserSettings(userId);
      const lang = ttsSettings.ttsLang || "zh";

      if (char.voice_id && char.tts_enabled) {
        try {
          const ttsScript = script
            .replace(/[（(][^）)]{0,80}[）)]/g, "")
            .replace(/[【\[][^\]】]{0,80}[\]】]/g, "")
            .replace(/\*[^*]{0,80}\*/g, "")
            .replace(/\s{2,}/g, " ").trim();
          let ttsInput = normalizeTtsText(ttsScript);
          if (lang === "ja") ttsInput = await translateToJapanese(ttsInput);
          const ch = char.voice_channel || "cosyvoice";
          voiceChannel = ch;
          const synthFn = pickSynthFn(ch);
          const tagsEnabled = (await getGlobalSetting("tts_tags_enabled", "1")) === "1";
          const instructionEnabled = (await getGlobalSetting("tts_instruction_enabled", "1")) === "1";
          const wantTags = tagsEnabled && QWEN_AUDIO_CHANNELS.has(ch) && lang === "zh";
          const callMood = getEffectiveMoodState(session).mood;
          const style = await generateTtsStyle(ttsInput, {
            charName: char.name,
            personality: char.personality || "",
            mood: callMood,
            wantInstruction: instructionEnabled,
            wantTags
          }).catch(() => ({ instruction: "", tagged: ttsInput }));
          if (wantTags) ttsInput = style.tagged || ttsInput;
          const callInstruction = style.instruction ? `带电话音效果，${style.instruction}` : "带电话音效果";
          console.log(`[tts][来电] 合成文本 ch=${ch} >>>\n${ttsInput}\n<<<`);
          const result = await synthFn(ttsInput, char.voice_id, lang, callInstruction);
          audioUrl = result.url;
          aliyunRequestId = result.aliyunRequestId || null;
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
      if (audioUrl) {
        await dbRun(
          "UPDATE messages SET tts_audio_url = ?, tts_aliyun_request_id = ?, tts_voice_id = ?, tts_voice_channel = ? WHERE id = ?",
          [audioUrl, aliyunRequestId, char.voice_id, voiceChannel, callMsgId]
        );
      }
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
  personality: "龙卷强势、嘴硬、自尊心高，对轻视很敏感；真正信任后会用别扭但实际的方式关心人，害羞时倾向回避或转移话题，而不是突然变得无条件顺从",
  description: "《一拳超人》动漫中的地狱龙卷",
  values_content: "重视实力、尊严和真正可靠的行动，不喜欢空洞吹捧。关心别人时更习惯用行动或嘴硬的提醒表达。",
  boundaries_content: "讨厌被轻视、命令或当成需要保护的小孩。关系不够亲近时会拒绝突兀的肢体接触和过度甜腻的称呼；认真道歉后会逐渐缓和，但不会瞬间忘掉芥蒂。",
  habits_content: "说话直接，耐心有限；尴尬时会转开话题或故意挑一句小毛病。闲下来喜欢安静待着，偶尔把刚看到的小事随口告诉熟悉的人。",
  speech_examples: "会说：‘你今天倒是挺准时。’、‘别误会，我只是顺手提醒你。’、‘行了，说重点。’\n不会说：‘当然亲爱的，我永远无条件支持你！’、‘作为AI我无法做到。’、每句话都用同一种傲娇口头禅。",
};

// 默认角色「龙卷」的预生成资产（来自 char id=49），新用户直接复用，避免重复生成浪费资源
const DEFAULT_CHARACTER_ASSETS = {
  voice_id: "cosyvoice-v3.5-plus-char49-57500d52c2e6416f8fb1c6975aa6738b",
  voice_channel: "cosyvoice",
  tts_enabled: 1,
  appearance_hash: "38061f87",
  // 官方参考图（当前激活卡片），默认龙卷后续生图都以此做图生图，保持形象统一
  reference_image_url: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780592855792_5f73e48338da60cc.png",
  avatars: {
    angry: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780598286084_f5884408db7bad69.png",
    annoyed: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780598096200_412f04c37c1e039b.png",
    cold: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780599062023_6b709f230d411645.png",
    flustered: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780597460042_00a03eb356eddf78.png",
    happy: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780598759575_586b957361973fd8.png",
    neutral: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780630837937_af3cf7884b65b1b5.png",
    playful: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780584087271_598d1717ebe42c15.png",
    shy: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780598975397_cb68afe0e70943b7.png",
    soft: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780599843771_3d03d621bc884baf.png",
  },
  cards: [
    { url: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780577832990_b6838a64b7051427.png", active: 0 },
    { url: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780592412968_d5f56b9703322c90.png", active: 0 },
    { url: "https://acgay.oss-cn-hangzhou.aliyuncs.com/test/log/outputs/1780592855792_5f73e48338da60cc.png", active: 1 },
  ],
};

// 为默认角色（龙卷）写入预生成的头像/卡片/音色，避免新用户重复生成
async function seedDefaultCharacterAssets(name, userId) {
  if (name !== DEFAULT_CHARACTER.name) return; // 仅默认角色
  const A = DEFAULT_CHARACTER_ASSETS;
  const now = nowIso();
  // 情绪头像
  for (const [mood, url] of Object.entries(A.avatars)) {
    await dbRun(
      "INSERT IGNORE INTO mood_avatars (`character`, mood, image_url, appearance_hash, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
      [name, mood, url, A.appearance_hash, now, userId ?? null]
    );
  }
  // 角色卡片
  for (const c of A.cards) {
    await dbRun(
      "INSERT INTO character_cards (`character`, image_url, is_active, created_at, user_id) VALUES (?, ?, ?, ?, ?)",
      [name, c.url, c.active ? 1 : 0, now, userId ?? null]
    );
  }
  // 音色 + 官方参考图（图生图基准）
  await dbRun(
    "UPDATE characters SET voice_id = ?, voice_channel = ?, tts_enabled = ?, reference_image_url = ? WHERE name = ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))",
    [A.voice_id, A.voice_channel, A.tts_enabled, A.reference_image_url, name, userId ?? null, userId ?? null]
  );
}


// 一次性回填：给所有名为「龙卷」且尚未设置参考图的角色补上官方参考图
// 已手动上传过参考图的角色不受影响（WHERE 限定 NULL/空）
async function backfillDefaultCharacterReferenceImage() {
  try {
    const result = await dbRun(
      "UPDATE characters SET reference_image_url = ? WHERE name = ? AND (reference_image_url IS NULL OR reference_image_url = '')",
      [DEFAULT_CHARACTER_ASSETS.reference_image_url, DEFAULT_CHARACTER.name]
    );
    const n = result?.affectedRows ?? 0;
    if (n > 0) console.log(`[回填] 已为 ${n} 个默认龙卷角色补上官方参考图`);
  } catch (e) {
    console.error("[回填] 默认龙卷参考图失败:", e.message);
  }
}

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
    "INSERT IGNORE INTO characters (name, appearance, personality, description, values_content, boundaries_content, habits_content, speech_examples, soul_content, is_active, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    [name, appearance, personality, description, name === DEFAULT_CHARACTER.name ? DEFAULT_CHARACTER.values_content : "", name === DEFAULT_CHARACTER.name ? DEFAULT_CHARACTER.boundaries_content : "", name === DEFAULT_CHARACTER.name ? DEFAULT_CHARACTER.habits_content : "", name === DEFAULT_CHARACTER.name ? DEFAULT_CHARACTER.speech_examples : "", remainingSoul, nowIso(), userId ?? null]
  );
  // 默认角色「龙卷」：写入预生成的头像/卡片/音色，跳过生成
  await seedDefaultCharacterAssets(name, userId);
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
  await backfillDefaultCharacterReferenceImage();
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
