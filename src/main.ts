import express from "express";
import { abortAllForShutdown } from "./bot/cancellation.js";
import { backgroundIdle } from "./bot/dispatcher.js";
import { startPolling, stopPolling } from "./bot/poller.js";
import { runEnrichmentWorker } from "./bot/enrichmentWorker.js";
import { pool } from "./db/pool.js";
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

const server = app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port}`);
});

// Not awaited: a question arriving meanwhile waits for the same load in Ollama.
void preloadModels();
// Before the sweeper retries interrupted uploads, so they aren't taken for duplicates.
await recoverInterruptedUploads();
const stopSweeper = startSweeper();
void startPolling();
void runEnrichmentWorker();

/**
 * Graceful shutdown (roadmap 8.9; `docker stop` sends SIGTERM and waits
 * stop_grace_period): stop taking updates, let running answers finish for a
 * while, then stop the rest. Their updates stay "received" in the inbox and
 * are answered after the restart. Uploads and enrichment resume on their own.
 */
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info(`[Shutdown] ${signal}: no new updates; waiting for running work`);
  stopPolling();
  stopSweeper();
  server.close();

  if (!(await backgroundIdle(config.shutdown.graceMs))) {
    logger.warn("[Shutdown] Stopping unfinished work; it is retried after the restart");
    abortAllForShutdown();
    // A moment for the stopped answers to say so in the chat.
    await backgroundIdle(config.shutdown.cleanupMs);
  }

  await pool.end().catch(() => undefined);
  logger.info("[Shutdown] Done");
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
