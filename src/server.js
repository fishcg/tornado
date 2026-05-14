import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { assertConfig, config } from "./config.js";
import { getDb, closeDb, initDb } from "./db.js";
import {
  clearAllMemories,
  deleteMemory,
  deleteEntity,
  getMemoryStats,
  listEntityGraph,
  listMemories
} from "./repositories/memory-repository.js";
import { consolidateMemories } from "./services/consolidate-service.js";
import { ingestText } from "./services/ingest-service.js";
import { answerQuestion } from "./services/query-service.js";
import { bootstrapInbox } from "./watch/watch-inbox.js";

const app = Fastify({
  logger: true
});

let watcher;
let consolidationTimer;

function publicFile(fileName) {
  return path.join(config.publicDir, fileName);
}

async function registerRoutes() {
  app.get("/", async (_, reply) => {
    reply.type("text/html").send(fs.readFileSync(publicFile("index.html"), "utf8"));
  });

  app.get("/app.js", async (_, reply) => {
    reply.type("application/javascript").send(fs.readFileSync(publicFile("app.js"), "utf8"));
  });

  app.get("/styles.css", async (_, reply) => {
    reply.type("text/css").send(fs.readFileSync(publicFile("styles.css"), "utf8"));
  });

  app.get("/status", async () => getMemoryStats());

  app.get("/memories", async (request) => {
    const sourcePrefix = request.query.source ? String(request.query.source).trim() : null;
    return listMemories(200, sourcePrefix);
  });

  app.get("/sources", async () => {
    const [rows] = await getDb().execute("SELECT DISTINCT source FROM memories WHERE source IS NOT NULL ORDER BY source ASC");
    return { sources: rows.map((r) => r.source) };
  });

  app.get("/graph", async (request) => {
    const sourcePrefix = request.query.source ? String(request.query.source).trim() : null;
    return listEntityGraph(500, sourcePrefix);
  });

  app.get("/query", async (request, reply) => {
    const question = String(request.query.q || "").trim();
    const sourcePrefix = request.query.source ? String(request.query.source).trim() : null;
    if (!question) {
      reply.code(400);
      return { error: "missing ?q= parameter" };
    }

    const answer = await answerQuestion(question, sourcePrefix);
    return { question, answer };
  });

  app.post("/ingest", async (request, reply) => {
    // console.log("============== ingest request body ==============");
    // console.log(request.body);
    const text = String(request.body?.text || "").trim();
    const source = String(request.body?.source || "api").trim();

    if (!text) {
      reply.code(400);
      return { error: "missing 'text' field" };
    }

    return ingestText(text, source);
  });

  app.post("/consolidate", async (request) => {
    const sourcePrefix = request.body?.source ? String(request.body.source).trim() : null;
    return consolidateMemories(sourcePrefix);
  });

  app.post("/delete", async (request, reply) => {
    const memoryId = Number(request.body?.memory_id);
    if (!memoryId) {
      reply.code(400);
      return { error: "missing 'memory_id' field" };
    }
    return deleteMemory(memoryId);
  });

  app.delete("/graph/entity/:name", async (request, reply) => {
    const name = decodeURIComponent(request.params.name || "").trim();
    if (!name) {
      reply.code(400);
      return { error: "missing entity name" };
    }
    return deleteEntity(name);
  });

  app.post("/clear", async () => clearAllMemories(config.watchDir));
}

async function startBackgroundJobs() {
  watcher = await bootstrapInbox(config.watchDir, app.log);
  consolidationTimer = setInterval(async () => {
    try {
      const stats = await getMemoryStats();
      if (stats.unconsolidated >= 2) {
        const result = await consolidateMemories();
        app.log.info(`consolidation: ${result.response}`);
      } else {
        app.log.info(`consolidation skipped: ${stats.unconsolidated} unconsolidated memories`);
      }
    } catch (error) {
      app.log.error(`consolidation failed: ${error.message}`);
    }
  }, config.consolidateEveryMinutes * 60 * 1000);
}

async function shutdown() {
  if (consolidationTimer) {
    clearInterval(consolidationTimer);
  }
  if (watcher) {
    await watcher.close();
  }
  await app.close();
  closeDb();
}

async function main() {
  assertConfig();
  await initDb();
  await registerRoutes();
  await startBackgroundJobs();
  await app.listen({ host: "0.0.0.0", port: config.port });
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
