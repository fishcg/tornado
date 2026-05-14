export const memorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["raw_text", "summary", "entities", "topics", "importance"],
  properties: {
    raw_text: {
      type: "string",
      maxLength: 4000
    },
    summary: {
      type: "string",
      maxLength: 1200
    },
    entities: {
      type: "array",
      maxItems: 20,
      items: {
        type: "string",
        maxLength: 60
      }
    },
    topics: {
      type: "array",
      maxItems: 12,
      items: {
        type: "string",
        maxLength: 60
      }
    },
    importance: {
      type: "number",
      minimum: 0,
      maximum: 1
    }
  }
};

export const consolidationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "insight", "connections", "entity_relations"],
  properties: {
    summary: { type: "string" },
    insight: { type: "string" },
    connections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from_id", "to_id", "relationship"],
        properties: {
          from_id: { type: "integer" },
          to_id: { type: "integer" },
          relationship: { type: "string" }
        }
      }
    },
    entity_relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_entity", "target_entity", "relationship", "evidence_memory_ids"],
        properties: {
          source_entity: {
            type: "string",
            maxLength: 120
          },
          target_entity: {
            type: "string",
            maxLength: 120
          },
          relationship: {
            type: "string",
            maxLength: 80
          },
          evidence_memory_ids: {
            type: "array",
            maxItems: 10,
            items: {
              type: "integer"
            }
          }
        }
      }
    }
  }
};

export const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string" }
  }
};
