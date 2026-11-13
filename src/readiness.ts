/**
 * Readiness (roadmap 8.11): can the bot answer right now? /health only says
 * the process is up; it stayed green while Ollama or the reranker was down.
 * Each dependency gets one cheap request with a short timeout.
 */
import { config } from "./config.js";
import { pool } from "./db/pool.js";

export type CheckResult = "ok" | "down" | "off";

export interface Readiness {
  ready: boolean;
  checks: { database: CheckResult; ollama: CheckResult; reranker: CheckResult };
}

const TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS)),
  ]);
}

async function check(work: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await withTimeout(work());
    return "ok";
  } catch {
    return "down";
  }
}

async function getOk(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function checkReadiness(): Promise<Readiness> {
  const [database, ollama, reranker] = await Promise.all([
    check(() => pool.query("SELECT 1")),
    check(() => getOk(`${new URL(config.llm.url).origin}/api/version`)),
    // A disabled reranker is not needed: answers fall back to vector order.
    config.reranker.enabled
      ? check(() => getOk(`${new URL(config.reranker.url).origin}/health`))
      : Promise.resolve<CheckResult>("off"),
  ]);

  return { ready: database === "ok" && ollama === "ok" && reranker !== "down", checks: { database, ollama, reranker } };
}
