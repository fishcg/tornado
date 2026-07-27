import {
  listConsolidations,
  listMemories
} from "../repositories/memory-repository.js";
import { generateStructured } from "../llm/openai-client.js";
import { answerSchema } from "./prompt-schemas.js";

export async function answerQuestion(question, sourcePrefix, exactSource = false) {
  // 必须在 SQL LIMIT 之前按用户+角色过滤，否则高活跃用户会把其他人的记忆
  // 挤出全局最近 N 条。listMemories 本身已按 created_at DESC 返回。
  let { memories } = await listMemories(200, sourcePrefix, exactSource);

  if (memories.length === 0) {
    return "";
  }

  const normalize = (value) => String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const q = normalize(question);
  const grams = new Set();
  const stopGrams = new Set(["我们", "你们", "他们", "这个", "那个", "什么", "怎么", "为什么", "还是", "就是", "然后", "现在", "今天", "觉得", "可以"]);
  for (let size = 2; size <= 4; size++) {
    for (let i = 0; i + size <= q.length; i++) {
      const gram = q.slice(i, i + size);
      if (!stopGrams.has(gram)) grams.add(gram);
    }
  }
  const scored = memories.map((memory, index) => {
    const haystack = normalize([
      memory.summary,
      memory.raw_text,
      ...(memory.topics || []),
      ...(memory.entities || [])
    ].join(" "));
    const exact = q.length >= 2 && haystack.includes(q);
    let lexical = exact ? 12 : 0;
    for (const gram of grams) if (haystack.includes(gram)) lexical += gram.length >= 3 ? 2 : 1;
    const importance = Number(memory.importance || 0) * 3;
    const recency = Math.max(0, 2 - index / 50);
    return { memory, score: lexical + importance + recency, lexical, exact };
  });
  // 没有真正相关的记忆时返回空，不能退回“最近记忆”；否则旧话题会被无关地重新注入。
  const relevant = scored
    .filter((item) => item.exact || item.lexical >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.memory);
  if (!relevant.length) return "";
  memories = relevant;

  const memoryIdSet = new Set(memories.map((memory) => memory.id));
  let consolidations = (await listConsolidations(500)).consolidations
    .filter((item) => Array.isArray(item.source_ids) && item.source_ids.some((id) => memoryIdSet.has(id)))
    .slice(0, 5);

  const result = await generateStructured({
    schemaName: "memory_query_answer",
    schema: answerSchema,
    model: "qwen-plus-latest",
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
