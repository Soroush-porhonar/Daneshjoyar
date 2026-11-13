import express from "express";
import { startPolling } from "./bot/poller.js";
import { runEnrichmentWorker } from "./bot/enrichmentWorker.js";
import { recoverInterruptedUploads } from "./bot/recovery.js";
import { startSweeper } from "./bot/sweeper.js";
import { config } from "./config.js";
import { preloadModels } from "./llm/ollamaClient.js";
import { logger } from "./logger.js";

const app = express();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "daneshjohandbot",
  });
});

app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port}`);
});

// Not awaited: a question arriving meanwhile waits for the same load in Ollama.
void preloadModels();
// Before the sweeper retries interrupted uploads, so they aren't taken for duplicates.
await recoverInterruptedUploads();
startSweeper();
void startPolling();
void runEnrichmentWorker();
