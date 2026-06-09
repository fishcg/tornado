// 集中配置：环境变量常量 + OpenAI 系列 client 实例
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "../../node_modules/openai/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/ 的上一级即 tornado/ 根目录
const ROOT_DIR = path.join(__dirname, "..");

export const PORT = Number(process.env.TORNADO_PORT || 3011);
export const MEMORY_API = process.env.MEMORY_API || "http://localhost:8880";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY || "";
export const OPENAI_API_URL =
  process.env.TORNADO_API_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const OPENAI_MODEL = process.env.TORNADO_MODEL || process.env.OPENAI_MODEL || "deepseek-v3.2";
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
export const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com";
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
export const IMAGE_API_URL = process.env.IMAGE_API_URL || "https://api.test.ai/openapi/v1/generate";
export const IMAGE_API_KEY = process.env.IMAGE_API_KEY || "";
export const SOUL_PATH = path.join(ROOT_DIR, "soul.md");
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");
export const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");
export const PROACTIVE_IDLE_MINUTES = Number(process.env.PROACTIVE_IDLE_MINUTES || 30);
export const WEATHER_CITY = process.env.WEATHER_CITY || "";
export const PASSWORD_SALT = process.env.PASSWORD_SALT || "tornado-default-salt-2025";
export const DEFAULT_INVITE_CODE = process.env.DEFAULT_INVITE_CODE || "tornado2025";

export const OSS_REGION = process.env.OSS_REGION || "";
export const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || "";
export const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || "";
export const OSS_BUCKET = process.env.OSS_BUCKET || "";
export const OSS_BASE_URL = process.env.OSS_BASE_URL || "";

export const NEWAPI_API_KEY = process.env.NEWAPI_API_KEY || "";
export const NEWAPI_MODEL = process.env.NEWAPI_MODEL || "grok-4.20-0309";

export const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_API_URL });
// DeepSeek 官方 API，用于主聊天对话
export const deepseek = new OpenAI({ apiKey: DEEPSEEK_API_KEY, baseURL: DEEPSEEK_API_URL });
// NewAPI — 仅 admin 可使用
export const newapi = new OpenAI({ apiKey: NEWAPI_API_KEY, baseURL: "https://api.glmbigmodel.me/v1" });
