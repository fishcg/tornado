import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mime from "mime-types";
import { config } from "../config.js";
import { generateStructured, transcribeAudio } from "../llm/openai-client.js";
import { storeMemory } from "../repositories/memory-repository.js";
import { memorySchema } from "./prompt-schemas.js";

const execFileAsync = promisify(execFile);

export const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".log", ".xml", ".yaml", ".yml"]);
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
export const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"]);
export const DOCUMENT_EXTENSIONS = new Set([".pdf"]);
export const ALL_SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS
]);

function normalizeMemoryResult(result, fallbackRawText = "") {
  const importanceValue = Number(result.importance ?? result.importance_score ?? 0.5);
  const normalizedImportance = Number.isFinite(importanceValue) ? importanceValue : 0.5;
  const rawText = String(result.raw_text || fallbackRawText || "").trim();

  return {
    rawText: rawText.slice(0, 4000),
    summary: String(result.summary || "").trim(),
    entities: Array.isArray(result.entities)
      ? result.entities.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : [],
    topics: Array.isArray(result.topics)
      ? result.topics.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
      : [],
    importance: Math.max(0, Math.min(1, normalizedImportance))
  };
}

async function extractVideoAudio(videoPath) {
  fs.mkdirSync(config.tmpDir, { recursive: true });
  const outputPath = path.join(config.tmpDir, `${path.basename(videoPath)}-${Date.now()}.mp3`);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-acodec",
      "mp3",
      outputPath
    ]);
    return outputPath;
  } catch (error) {
    throw new Error(`ffmpeg failed for ${path.basename(videoPath)}: ${error.message}`);
  }
}

async function analyzeText(text, source, hint = "") {
  const input = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            `Source: ${source || "unknown"}`,
            hint ? `Context: ${hint}` : "",
            "Analyze this content and extract a durable memory.",
            "Use the exact keys raw_text, summary, entities, topics, importance.",
            "raw_text should preserve key details, specific facts, preferences, names, dates, and personal information mentioned. Stay under 3500 characters.",
            "summary should capture the main points with enough detail to be useful later.",
            "Return entity/topic labels, and an importance score from 0.0 to 1.0.",
            "",
            text
          ]
            .filter(Boolean)
            .join("\n")
        }
      ]
    }
  ];

  const result = await generateStructured({
    schemaName: "memory_ingest",
    schema: memorySchema,
    instructions:
      "你是一个记忆摄入系统。请尽量保留原文中的具体细节、个人偏好、人名、地名、时间、数字、情感态度等有价值的信息。raw_text 应该是详细的中文转述，保留关键细节而不是过度压缩。summary 要包含足够的细节以便日后回忆。使用简短的实体/主题标签，并对重要性进行评分（范围 0.0 到 1.0）。请严格使用以下 JSON 键名：raw_text、summary、entities、topics、importance。仅返回 json 格式数据，不要换行，注意特殊字符转义，不要输出额外的符号或字符，也不要加 markdonw 等语法，即第一个字符必须是 {，最后一个字符必须是 } ",
    input
  });

  return normalizeMemoryResult(result, text);
}

async function analyzeImage(filePath, source) {
  const mimeType = mime.lookup(filePath) || "application/octet-stream";
  const base64 = fs.readFileSync(filePath, "base64");

  const result = await generateStructured({
    schemaName: "memory_image_ingest",
    schema: memorySchema,
    instructions:
      "\n" +
      "你负责为长期记忆系统分析图像。请描述可见内容（包括任何可读文本），总结关键信息，提取实体与主题，并估算重要性。请严格使用以下 JSON 键名：raw_text、summary、entities、topics、importance。其中 raw_text 应当简洁且经过转述。.仅返回 json 格式数据，不要换行，注意特殊字符转义，不要输出额外的符号或字符，也不要加 markdonw 等语法，即第一个字符必须是 {，最后一个字符必须是 } ",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Analyze this image from source ${source}.`
          },
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${base64}`
          }
        ]
      }
    ]
  });

  return normalizeMemoryResult(result);
}

async function analyzePdf(filePath, source) {
  const base64 = fs.readFileSync(filePath, "base64");
  const result = await generateStructured({
    schemaName: "memory_pdf_ingest",
    schema: memorySchema,
    instructions:
      "You analyze PDF files for a long-term memory system. Extract key content, summarize accurately, list important entities/topics, and estimate importance. Use the exact JSON keys raw_text, summary, entities, topics, importance. raw_text should be concise and paraphrased.仅返回 json 格式数据，不要换行，注意特殊字符转义，不要输出额外的符号或字符，也不要加 markdonw 等语法，即第一个字符必须是 {，最后一个字符必须是 } ",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Analyze this PDF from source ${source}.`
          },
          {
            type: "input_file",
            filename: path.basename(filePath),
            file_data: `data:application/pdf;base64,${base64}`
          }
        ]
      }
    ]
  });

  return normalizeMemoryResult(result);
}

async function analyzeAudio(filePath, source) {
  const transcript = await transcribeAudio(filePath);
  if (!transcript.trim()) {
    throw new Error(`Audio transcription was empty for ${source}`);
  }

  return analyzeText(transcript, source, "This memory came from transcribed audio.");
}

async function analyzeVideo(filePath, source) {
  const extractedAudio = await extractVideoAudio(filePath);
  try {
    const transcript = await transcribeAudio(extractedAudio);
    if (!transcript.trim()) {
      throw new Error(`Video transcription was empty for ${source}`);
    }
    return analyzeText(
      transcript,
      source,
      "This memory came from video audio transcription. Visual details may be missing."
    );
  } finally {
    fs.rmSync(extractedAudio, { force: true });
  }
}

export async function ingestText(text, source = "api") {
  const normalized = await analyzeText(text, source);
  const stored = await storeMemory({
    source,
    rawText: normalized.rawText,
    summary: normalized.summary,
    entities: normalized.entities,
    topics: normalized.topics,
    importance: normalized.importance
  });

  return {
    ...stored,
    response: `Stored memory #${stored.memory_id}: ${normalized.summary}`
  };
}

export async function ingestFile(filePath) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const requiresInlineUpload = IMAGE_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext);
  if (requiresInlineUpload && stat.size > config.maxInlineFileBytes) {
    throw new Error(`${path.basename(filePath)} exceeds inline processing size limit`);
  }

  const source = path.basename(filePath);
  let normalized;

  if (TEXT_EXTENSIONS.has(ext)) {
    const text = fs.readFileSync(filePath, "utf8").slice(0, 50000);
    normalized = await analyzeText(text, source);
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    normalized = await analyzeImage(filePath, source);
  } else if (DOCUMENT_EXTENSIONS.has(ext)) {
    normalized = await analyzePdf(filePath, source);
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    normalized = await analyzeAudio(filePath, source);
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    normalized = await analyzeVideo(filePath, source);
  } else {
    throw new Error(`Unsupported file extension: ${ext || "<none>"}`);
  }

  const stored = await storeMemory({
    source,
    rawText: normalized.rawText,
    summary: normalized.summary,
    entities: normalized.entities,
    topics: normalized.topics,
    importance: normalized.importance
  });

  return {
    ...stored,
    response: `Stored memory #${stored.memory_id}: ${normalized.summary}`
  };
}
