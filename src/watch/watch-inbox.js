import fs from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import {
  isFileProcessed,
  markFileProcessed
} from "../repositories/memory-repository.js";
import { ALL_SUPPORTED_EXTENSIONS, ingestFile } from "../services/ingest-service.js";

function isSupported(filePath) {
  return ALL_SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function processFile(filePath, logger) {
  const resolved = path.resolve(filePath);
  if (await isFileProcessed(resolved) || !isSupported(resolved)) {
    return;
  }

  try {
    await ingestFile(resolved);
    await markFileProcessed(resolved);
    logger.info(`processed ${path.basename(resolved)}`);
  } catch (error) {
    logger.error(`failed to process ${path.basename(resolved)}: ${error.message}`);
  }
}

export async function bootstrapInbox(rootDir, logger) {
  fs.mkdirSync(rootDir, { recursive: true });

  for (const entry of fs.readdirSync(rootDir)) {
    const fullPath = path.join(rootDir, entry);
    if (fs.statSync(fullPath).isFile()) {
      await processFile(fullPath, logger);
    }
  }

  const watcher = chokidar.watch(rootDir, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1500,
      pollInterval: 100
    }
  });

  watcher.on("add", (filePath) => {
    void processFile(filePath, logger);
  });

  return watcher;
}
