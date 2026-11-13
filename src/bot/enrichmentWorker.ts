import {
  claimPendingDocument,
  resetRunningEnrichment,
  setEnrichmentStatus,
} from "../db/enrichment.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { enrichDocument } from "../rag/enrich.js";
import { runAs } from "../llm/scheduler.js";

let wake: (() => void) | null = null;

/** Starts the next document right away instead of at the next poll (after an upload). */
export function wakeEnrichment(): void {
  wake?.();
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

/**
 * Enriches queued documents one at a time, forever. Its model calls are the
 * GPU queue's lowest class: they wait while any question is being answered
 * (src/llm/scheduler.ts). A failure marks only that
 * document failed; the document stays usable without enrichment.
 */
export async function runEnrichmentWorker(): Promise<never> {
  try {
    const restarted = await resetRunningEnrichment();
    if (restarted > 0) logger.info(`[Enrich] ${restarted} interrupted enrichment(s) queued again`);
  } catch (error: unknown) {
    logger.error("[Enrich] Could not reset interrupted enrichment:", error);
  }

  while (true) {
    let documentId: number | null = null;

    try {
      documentId = await claimPendingDocument();

      if (documentId === null) {
        await pause(config.enrichment.pollMs);
        continue;
      }

      const id = documentId;
      await runAs({ kind: "enrich" }, () => enrichDocument(id));
    } catch (error: unknown) {
      logger.error("[Enrich] Enrichment failed:", { documentId, error });
      if (documentId !== null) {
        await setEnrichmentStatus(documentId, "failed").catch(() => {});
      }
      await pause(config.enrichment.pollMs);
    }
  }
}
