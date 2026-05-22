import {
  listConsolidations,
  listMemories
} from "../repositories/memory-repository.js";
import { generateStructured } from "../llm/openai-client.js";
import { answerSchema } from "./prompt-schemas.js";

export async function answerQuestion(question, sourcePrefix) {
  let { memories } = await listMemories(200);
  let consolidations = (await listConsolidations(10)).consolidations;

  // 按 source 前缀过滤，只保留该角色的记忆
  if (sourcePrefix) {
    const filtered = memories.filter((m) => m.source && m.source.startsWith(sourcePrefix));
    if (filtered.length > 0) {
      memories = filtered;
      // consolidations 也只保留 source_ids 全部属于该角色记忆的
      const memoryIdSet = new Set(memories.map((m) => m.id));
      consolidations = consolidations.filter(
        (c) => Array.isArray(c.source_ids) && c.source_ids.length > 0 && c.source_ids.every((id) => memoryIdSet.has(id))
      );
    } else {
      // 该角色没有任何记忆，直接返回空，不 fallback 到其他角色的记忆
      memories = [];
    }
  }

  // 截取最近 50 条
  memories = memories.slice(-50);

  if (memories.length === 0) {
    return "No memories stored yet.";
  }

  const result = await generateStructured({
    schemaName: "memory_query_answer",
    schema: answerSchema,
    model: "qwen3-8b",
    enable_thinking: false,
    instructions:
      "Answer using only the provided memories and consolidations. Cite memory IDs like [Memory 3]. If evidence is weak, say so directly. 仅返回 json 格式数据，不要换行，注意特殊字符转义，不要输出额外的符号或字符，也不要加 markdonw 等语法，即第一个字符必须是 {，最后一个字符必须是 } ",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `Question: ${question}`,
              "",
              "Memories:",
              JSON.stringify(
                memories.map((memory) => ({
                  id: memory.id,
                  source: memory.source,
                  summary: memory.summary,
                  raw_text: memory.raw_text,
                  topics: memory.topics,
                  entities: memory.entities,
                  importance: memory.importance,
                  connections: memory.connections
                })),
                null,
                2
              ),
              "",
              "Consolidations:",
              JSON.stringify(consolidations, null, 2)
            ].join("\n")
          }
        ]
      }
    ]
  });

  return String(result.answer || "").trim();
}
