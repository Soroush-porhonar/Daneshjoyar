/**
 * Tells the admin when something keeps failing (roadmap 8.11): failures are
 * counted by kind over a window; at the kind's threshold a Bale message goes
 * to ADMIN_CHAT_ID, at most once per kind per quiet period. Without an admin
 * chat the alert is only logged. Never throws: alerting must not break the
 * work that failed.
 */
// errors.ts imports this module and bale.ts imports errors.ts: a cycle, but
// bale.ts uses BaleApiError only inside functions, never while loading.
import { sendMessage } from "./bale.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { adminAlertText } from "./messages.js";

export type FailureKind = "ollama" | "reranker" | "database" | "queue" | "gpu";

/** Failures within the window that trigger an alert. One GPU crash or full queue is already news. */
const THRESHOLDS: Record<FailureKind, number> = { ollama: 3, reranker: 3, database: 3, queue: 1, gpu: 1 };

const failures = new Map<FailureKind, number[]>();
const lastAlert = new Map<FailureKind, number>();

/** Records one failure of `kind`; alerts the admin when the kind crosses its threshold. */
export function recordFailure(kind: FailureKind, now = Date.now()): void {
  const recent = (failures.get(kind) ?? []).filter((at) => now - at < config.alerts.windowMs);
  recent.push(now);
  failures.set(kind, recent);

  if (recent.length < THRESHOLDS[kind]) return;
  if (now - (lastAlert.get(kind) ?? -Infinity) < config.alerts.quietMs) return;
  lastAlert.set(kind, now);

  const text = adminAlertText(kind, recent.length, Math.round(config.alerts.windowMs / 60_000));
  logger.error(`[Alert] ${kind}: ${recent.length} failures in the window`);
  if (config.alerts.adminChatId === null) return;

  void sendMessage(config.alerts.adminChatId, text).catch((error: unknown) =>
    logger.error("[Alert] Could not message the admin:", error),
  );
}

/** For tests: forget all counts. */
export function resetAlerts(): void {
  failures.clear();
  lastAlert.clear();
}
