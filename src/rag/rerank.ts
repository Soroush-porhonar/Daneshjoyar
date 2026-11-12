/**
 * Reranking: vector search finds chunks on the right *topic*; a cross-encoder
 * reads the question and each chunk together and scores how well the chunk
 * *answers* the question. Used to re-order the top search candidates.
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import { contextualText, withTitle } from "./chunk.js";
import { isPhotoFilename } from "./documentKind.js";

interface RerankResponse {
  results?: { index: number; relevance_score: number }[];
}

interface RerankableChunk {
  content: string;
  sectionTitle?: string | null;
  context?: string | null;
  documentTitle?: string | null;
  filename?: string;
}

/**
 * What the reranker reads: the same text the chunk was searched by (slide
 * title, and context when enriched; photos always with it, see retrieve.ts).
 */
function rerankText(chunk: RerankableChunk): string {
  if ((config.rag.chunkContext || isPhotoFilename(chunk.filename)) && chunk.context) {
    return contextualText(chunk.documentTitle, chunk.sectionTitle, chunk.context, chunk.content);
  }
  return config.rag.chunking.titleInEmbedding ? withTitle(chunk.sectionTitle, chunk.content) : chunk.content;
}

/** One result per text (any order), validated; throws when the service fails or answers badly. */
async function requestScores(query: string, texts: string[]): Promise<{ index: number; relevance_score: number }[]> {
  const response = await fetch(config.reranker.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(config.reranker.timeoutMs),
    body: JSON.stringify({ query, documents: texts }),
  });

  if (!response.ok) {
    throw new Error(`Reranker error: ${response.status} ${response.statusText}`);
  }

  const results = ((await response.json()) as RerankResponse).results;

  if (
    !results ||
    results.length !== texts.length ||
    results.some((r) => !Number.isInteger(r.index) || r.index < 0 || r.index >= texts.length)
  ) {
    throw new Error("Reranker returned an invalid response");
  }

  return results;
}

/**
 * The cross-encoder's score of each text against the query, in the order of
 * `texts` (one text is fine). Used to check a claim against a source (the
 * evals' citation check). Null when the reranker is off, down, or answers badly.
 */
export async function scoreTexts(query: string, texts: string[]): Promise<number[] | null> {
  if (!config.reranker.enabled || texts.length === 0) return null;

  try {
    const scores = new Array<number | undefined>(texts.length).fill(undefined);
    for (const result of await requestScores(query, texts)) scores[result.index] = result.relevance_score;

    if (scores.some((score) => score === undefined)) {
      throw new Error("Reranker returned an invalid response");
    }

    return scores as number[];
  } catch (error: unknown) {
    logger.warn("[RAG] Scoring texts failed:", error);
    return null;
  }
}

/**
 * Returns the chunks ordered by relevance to the question (best first), each
 * with its `rerankScore`.
 * On any failure the original order is kept, so search still works when the
 * reranker service is down.
 */
export async function rerankChunks<T extends RerankableChunk>(
  question: string,
  chunks: T[],
): Promise<(T & { rerankScore?: number })[]> {
  if (!config.reranker.enabled || chunks.length < 2) return chunks;

  try {
    const results = await requestScores(question, chunks.map(rerankText));

    return [...results]
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((result) => ({ ...chunks[result.index]!, rerankScore: result.relevance_score }));
  } catch (error: unknown) {
    logger.warn("[RAG] Reranking failed, keeping search order:", error);
    return chunks;
  }
}
