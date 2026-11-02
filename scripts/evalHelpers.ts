/** Shared by the eval scripts. */
import { config } from "../src/config.js";
import { SOURCES_HEADING } from "../src/messages.js";
import { rankedCandidates, relevantHits } from "../src/rag/retrieve.js";
import type { ChunkRef } from "../src/rag/retrieve.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

/**
 * What a follow-up's previous answer was based on (production reads it from
 * answer_logs): the relevant hits for the last user message in the history,
 * searched like the question itself (all the user's documents, or `documentId`).
 */
export async function previousHits(
  owner: { user_id: number },
  history: HistoryMessage[] = [],
  documentId?: number,
): Promise<ChunkRef[]> {
  const last = [...history].reverse().find((message) => message.role === "user");
  if (!last) return [];

  const ranked = relevantHits(
    await rankedCandidates(owner.user_id, last.content, documentId === undefined ? {} : { documentId }),
  );
  return ranked
    .slice(0, config.rag.retrievalLimits.focused)
    .map(({ documentId, chunkIndex }) => ({ documentId, chunkIndex }));
}

/**
 * The pages an answer's sources list cites in `filename`
 * ("- [2] notes.pdf — صفحه 3", or a range "صفحه 3 تا 5" for a chunk crossing pages).
 */
export function citedPages(answer: string, filename: string): number[] {
  const sources = answer.split(SOURCES_HEADING)[1] ?? "";

  return sources.split("\n").flatMap((line) => {
    const match = /^- (?:\[\d+\] )?(.+) — صفحه (\d+)(?: تا (\d+))?$/.exec(line.trim());
    if (!match || match[1] !== filename) return [];

    const first = Number(match[2]);
    const last = Number(match[3] ?? match[2]);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  });
}
