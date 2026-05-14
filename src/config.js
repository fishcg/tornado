import path from "node:path";

const cwd = process.cwd();

export const config = {
  port: Number(process.env.PORT || 8880),
  watchDir: process.env.WATCH_DIR || path.join(cwd, "inbox"),
  dbPath: process.env.MEMORY_DB || path.join(cwd, "memory.db"),
  consolidateEveryMinutes: Number(process.env.CONSOLIDATE_EVERY_MIN || 30),
  // "openai" = Responses API (DashScope/Qwen/OpenAI), "deepseek" = Chat Completions API
  llmProvider: process.env.LLM_PROVIDER || "openai",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiApiUrl: process.env.OPENAI_API_URL || "https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1",
  openaiModel: process.env.OPENAI_MODEL || "qwen3.5-plus",
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "qwen3.5-plus",
  enableThinking: process.env.ENABLE_THINKING === "true",
  reasoningEffort: process.env.REASONING_EFFORT || "high",
  maxInlineFileBytes: Number(process.env.MAX_INLINE_FILE_BYTES || 15 * 1024 * 1024),
  pollFallbackMs: Number(process.env.WATCH_POLL_MS || 5000),
  publicDir: path.join(cwd, "public"),
  tmpDir: path.join(cwd, "tmp")
};

export function assertConfig() {
  if (!config.openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }
}
