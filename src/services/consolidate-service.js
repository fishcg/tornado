import {
  listMemories,
  listUnconsolidatedMemories,
  storeConsolidation
} from "../repositories/memory-repository.js";
import { generateStructured } from "../llm/openai-client.js";
import { consolidationSchema } from "./prompt-schemas.js";

export async function consolidateMemories(sourcePrefix = null, { exactSource = false } = {}) {
  const { memories: unconsolidated } = await listUnconsolidatedMemories(10, sourcePrefix, exactSource);
  if (unconsolidated.length < 1) {
    return {
      status: "skipped",
      response: "Nothing to consolidate yet."
    };
  }

  const { memories: recentMemories } = await listMemories(25, sourcePrefix, exactSource);
  const memories = [...unconsolidated];

  for (const memory of recentMemories) {
    if (memories.length >= 10) {
      break;
    }
    if (memories.some((item) => item.id === memory.id)) {
      continue;
    }
    memories.push(memory);
  }

  if (memories.length < 2) {
    return {
      status: "skipped",
      response: "Need at least two memories to consolidate."
    };
  }

  const result = await generateStructured({
    schemaName: "memory_consolidation",
    schema: consolidationSchema,
    instructions:
      "You are consolidating long-term memories. Focus on the newest unconsolidated memories, but you may connect them to any provided related memory. Find meaningful cross-memory patterns, keep relationships concrete, and write one actionable insight. Only emit connections when the relationship is directly supported by the memories. For entity_relations, output normalized canonical entity names, directional relationships, and evidence_memory_ids that only reference the provided memory ids. Merge obvious aliases such as multilingual variants into one canonical entity name when the memories clearly support it. Only emit entity_relations when the evidence is explicit in the memories. IMPORTANT: the 'relationship' field in entity_relations MUST be written in Chinese (简体中文), concise and under 10 characters. 仅返回 json 格式数据，不要换行，注意特殊字符转义，不要输出额外的符号或字符，也不要加 markdonw 等语法，即第一个字符必须是 {，最后一个字符必须是 } ",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Consolidate these memories.",
              `Newest memory ids to prioritize: ${unconsolidated.map((memory) => memory.id).join(", ") || "none"}`,
              JSON.stringify(
                memories.map((memory) => ({
                  id: memory.id,
                  source: memory.source,
                  summary: memory.summary,
                  raw_text: memory.raw_text,
                  entities: memory.entities,
                  topics: memory.topics,
                  importance: memory.importance,
                  consolidated: Boolean(memory.consolidated)
                })),
                null,
                2
              )
            ].join("\n\n")
          }
        ]
      }
    ]
  });

  const sourceIds = memories.map((memory) => memory.id);
  const markConsolidatedIds = unconsolidated.map((memory) => memory.id);
  const stored = await storeConsolidation({
    sourceIds,
    markConsolidatedIds,
    summary: String(result.summary || "").trim(),
    insight: String(result.insight || "").trim(),
    connections: Array.isArray(result.connections) ? result.connections : [],
    entityRelations: Array.isArray(result.entity_relations) ? result.entity_relations : []
  });

  return {
    ...stored,
    response: stored.insight
  };
}
