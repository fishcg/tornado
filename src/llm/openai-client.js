import fs from "node:fs";
import OpenAI from "openai";
import { config } from "../config.js";

const client = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiApiUrl && { baseURL: config.openaiApiUrl })
});

const isDeepSeek = config.llmProvider === "deepseek";

// ── Responses API helpers (OpenAI / DashScope / Qwen) ──

function extractParsedOutput(response) {
  if (response.output_parsed) {
    return response.output_parsed;
  }

  if (!Array.isArray(response.output)) {
    return null;
  }

  for (const item of response.output) {
    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content?.parsed) {
        return content.parsed;
      }
    }
  }

  return null;
}

function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  if (!Array.isArray(response.output)) {
    return "";
  }

  const parts = [];
  for (const item of response.output) {
    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

// ── JSON parsing helpers ──

function getJsonCandidates(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }

  const candidates = [trimmed];
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1).trim());
  }

  return [...new Set(candidates.filter(Boolean))];
}

function parseJsonText(text) {
  let lastError;

  for (const candidate of getJsonCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const preview = String(text || "").replace(/\s+/g, " ").slice(0, 300);
  throw new Error(
    `Failed to parse structured response JSON: ${lastError?.message || "unknown parse error"}. Preview: ${preview}`
  );
}

function parseStructuredResponse(response) {
  const parsed = extractParsedOutput(response);
  if (parsed) {
    return parsed;
  }

  const text = extractOutputText(response);
  if (!text) {
    throw new Error("LLM response did not contain structured output text");
  }

  return parseJsonText(text);
}

// ── Input format conversion: Responses API → Chat Completions ──

function convertInputToMessages(instructions, input) {
  const messages = [];

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (!Array.isArray(input)) {
    messages.push({ role: "user", content: String(input) });
    return messages;
  }

  for (const item of input) {
    const role = item.role || "user";

    if (!Array.isArray(item.content)) {
      messages.push({ role, content: String(item.content || "") });
      continue;
    }

    const parts = [];
    for (const block of item.content) {
      if (block.type === "input_text") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "input_image") {
        parts.push({
          type: "image_url",
          image_url: { url: block.image_url }
        });
      } else if (block.type === "input_file") {
        parts.push({
          type: "text",
          text: `[File: ${block.filename}] (binary content omitted)`
        });
      } else if (block.type === "text") {
        parts.push({ type: "text", text: block.text });
      }
    }

    messages.push({ role, content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
  }

  return messages;
}

// ── Chat Completions path (DeepSeek) ──

async function generateViaCompletions({ schemaName, schema, instructions, input, model, enable_thinking }) {
  const messages = convertInputToMessages(instructions, input);

  if (schema) {
    const schemaHint = `\nRespond with a JSON object matching this schema: ${JSON.stringify(schema)}`;
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content += schemaHint;
    } else {
      messages.unshift({ role: "system", content: schemaHint.trim() });
    }
  }

  const params = {
    model,
    messages,
    response_format: { type: "json_object" },
    stream: false
  };

  if (enable_thinking) {
    params.thinking = { type: "enabled" };
    params.reasoning_effort = config.reasoningEffort;
  }

  const response = await client.chat.completions.create(params);
  const text = response.choices?.[0]?.message?.content || "";

  if (!text.trim()) {
    throw new Error("DeepSeek response did not contain output text");
  }

  return parseJsonText(text);
}

// ── Responses API path (OpenAI / DashScope / Qwen) ──

async function generateViaResponses({ schemaName, schema, instructions, input, model, enable_thinking }) {
  const response = await client.responses.create({
    model,
    enable_thinking,
    instructions,
    input,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema
      }
    },
    response_format: {
      type: "json_object"
    }
  });

  return parseStructuredResponse(response);
}

// ── Public API ──

export async function generateStructured({ schemaName, schema, instructions, input, model = config.openaiModel, enable_thinking = config.enableThinking }) {
  const args = { schemaName, schema, instructions, input, model, enable_thinking };

  if (isDeepSeek) {
    return generateViaCompletions(args);
  }
  return generateViaResponses(args);
}

export async function transcribeAudio(filePath) {
  const result = await client.audio.transcriptions.create({
    model: config.transcriptionModel,
    file: fs.createReadStream(filePath)
  });

  return result.text || "";
}
