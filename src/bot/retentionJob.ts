import { config } from "../config.js";
import { applyRetention } from "../db/retention.js";
import { logger } from "../logger.js";

async function runOnce(): Promise<void> {
  try {
    const removed = await applyRetention();
    logger.info("[Retention] Old data removed", removed);
  } catch (error: unknown) {
    logger.error("[Retention] Failed:", error);
  }
}

/**
 * Applies the retention rules (src/db/retention.ts) shortly after startup and
 * then once a day. Returns a function that stops it.
 */
export function startRetentionJob(): () => void {
  const first = setTimeout(() => void runOnce(), config.retention.firstRunDelayMs);
  const daily = setInterval(() => void runOnce(), config.retention.intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
