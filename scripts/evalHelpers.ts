/** Shared by the eval scripts. */
import { config } from "../src/config.js";
import { rankedCandidates, relevantHits } from "../src/rag/retrieve.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

/**
 * What a follow-up's previous answer was based on (production reads it from
 * answer_logs): the relevant hits for the last user message in the history.
 */
export async function previousHits(
  document: { id: number; user_id: number },
  history: HistoryMessage[] = [],
): Promise<number[]> {
  const last = [...history].reverse().find((message) => message.role === "user");
  if (!last) return [];

  const ranked = relevantHits(await rankedCandidates(document.user_id, last.content, document.id));
  return ranked.slice(0, config.rag.retrievalLimits.focused).map((chunk) => chunk.chunkIndex);
}
