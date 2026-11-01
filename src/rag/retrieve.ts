import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { generateEmbedding } from "./embeddings.js";
import { rerankChunks } from "./rerank.js";
import { PERSIAN_STOPWORDS } from "./stopwords.js";
import { normalizeText } from "./textQuality.js";

export interface RetrievedChunk {
  documentId: number;
  filename: string;
  pageNumber: number | null;
  /** Last page of a chunk that crosses pages; null for older chunks. */
  pageEnd?: number | null;
  chunkIndex: number;
  /** Slide decks: chunks with the same title share a section; null otherwise. */
  sectionIndex?: number | null;
  /** Slide decks: the slide title (part of the embedded text); null otherwise. */
  sectionTitle?: string | null;
  content: string;
  distance: number;
  /** Cross-encoder relevance (higher is better); missing when the reranker is off or failed. */
  rerankScore?: number;
}

/** A chunk that will be placed in the model's context (a hit or its neighbour). */
export interface ContextChunk {
  documentId: number;
  filename: string;
  pageNumber: number | null;
  pageEnd?: number | null;
  chunkIndex: number;
  sectionIndex?: number | null;
  content: string;
  /** True for a direct search hit, false for a neighbour added for context. */
  isHit: boolean;
}

export type ContextMode = "focused" | "multi_part";

export interface DocumentChunk {
  documentId: number;
  filename: string;
  pageNumber: number | null;
  pageEnd?: number | null;
  chunkIndex: number;
  content: string;
}

/**
 * Retrieves every chunk belonging to a specific completed document.
 * Used for whole-document summaries, regardless of similarity to a query.
 */
export async function getDocumentChunks(
  userId: number,
  documentId: number,
): Promise<DocumentChunk[]> {
  const result = await pool.query<DocumentChunk>(
    `SELECT
       d.id AS "documentId",
       d.filename,
       dc.page_number AS "pageNumber",
       dc.page_end AS "pageEnd",
       dc.chunk_index AS "chunkIndex",
       dc.content
     FROM documents d
     JOIN document_chunks dc ON dc.document_id = d.id
     WHERE d.user_id = $1
       AND d.id = $2
       AND d.status = 'completed'
     ORDER BY
       dc.page_number ASC NULLS LAST,
       dc.chunk_index ASC`,
    [userId, documentId],
  );

  if (result.rows.length === 0) {
    throw new Error(
      `No completed document chunks found for document ${documentId}.`,
    );
  }

  return result.rows;
}

function checkLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("Retrieval limit must be an integer between 1 and 20.");
  }
}

/**
 * Retrieves chunks semantically relevant to a question (vector search only).
 * Used for focused and multi-part questions.
 */
export async function retrieveRelevantChunks(
  userId: number,
  question: string,
  limit = 4,
  documentId?: number,
  /** Chunks farther than this are dropped; the eval passes a looser value. */
  maxDistance: number = config.rag.maxCosineDistance,
): Promise<RetrievedChunk[]> {
  checkLimit(limit);
  const embedding = await generateEmbedding(question);
  return vectorSearch(userId, embedding, limit, documentId, maxDistance);
}

async function vectorSearch(
  userId: number,
  embedding: number[],
  limit: number,
  documentId: number | undefined,
  maxDistance: number,
): Promise<RetrievedChunk[]> {
  const vector = `[${embedding.join(",")}]`;

  const result = await pool.query<RetrievedChunk>(
    `WITH ranked_chunks AS (
       SELECT
         dc.document_id AS "documentId",
         d.filename,
         dc.page_number AS "pageNumber",
         dc.page_end AS "pageEnd",
         dc.chunk_index AS "chunkIndex",
         dc.section_index AS "sectionIndex",
         dc.section_title AS "sectionTitle",
         dc.content,
         dc.embedding <=> $2::vector AS distance,
         ROW_NUMBER() OVER (
           PARTITION BY
            dc.document_id,
            dc.page_number,
            dc.content
           ORDER BY
             CASE WHEN dc.page_number IS NOT NULL THEN 0 ELSE 1 END,
             d.id DESC,
             dc.id DESC
         ) AS duplicate_rank
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE d.user_id = $1
         AND d.status = 'completed'
         AND ($4::integer IS NULL OR dc.document_id = $4)
     )
     SELECT
       "documentId",
       filename,
       "pageNumber",
       "pageEnd",
       "chunkIndex",
       "sectionIndex",
       "sectionTitle",
       content,
       distance
     FROM ranked_chunks
     WHERE duplicate_rank = 1
       AND distance <= $5
     ORDER BY distance ASC
     LIMIT $3`,
    [userId, vector, limit, documentId ?? null, maxDistance],
  );
  logger.debug(
    "[RAG] Retrieved chunks:",
    result.rows.map((chunk) => ({
      documentId: chunk.documentId,
      pageNumber: chunk.pageNumber,
      distance: Number(chunk.distance),
      contentPreview: chunk.content.slice(0, 120),
    })),
  );
  return result.rows;
}

/** The question's meaningful words for keyword search (common Persian words removed). */
export function keywordTerms(question: string): string[] {
  const words = normalizeText(question)
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((word) => word.length > 1 && !PERSIAN_STOPWORDS.has(word));

  return [...new Set(words)];
}

/**
 * Keyword search with PostgreSQL full-text ('simple' config): finds exact terms
 * such as "29119", "JMeter" or "Q(14,3)" that embeddings may blur. Any of the
 * question's words may match; chunks with more of them, closer together, rank higher.
 */
async function keywordSearch(
  userId: number,
  question: string,
  embedding: number[],
  limit: number,
  documentId: number | undefined,
): Promise<RetrievedChunk[]> {
  const terms = keywordTerms(question);
  if (terms.length === 0) return [];

  const result = await pool.query<RetrievedChunk>(
    `WITH q AS (
       SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS query
       FROM unnest(tsvector_to_array(to_tsvector('simple', $2))) AS lexeme
     )
     SELECT
       dc.document_id AS "documentId",
       d.filename,
       dc.page_number AS "pageNumber",
       dc.page_end AS "pageEnd",
       dc.chunk_index AS "chunkIndex",
       dc.section_index AS "sectionIndex",
       dc.section_title AS "sectionTitle",
       dc.content,
       dc.embedding <=> $5::vector AS distance
     FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     CROSS JOIN q
     WHERE d.user_id = $1
       AND d.status = 'completed'
       AND ($4::integer IS NULL OR dc.document_id = $4)
       AND dc.content_tsv @@ q.query
     ORDER BY ts_rank_cd(dc.content_tsv, q.query) DESC, dc.chunk_index
     LIMIT $3`,
    [userId, terms.join(" "), limit, documentId ?? null, `[${embedding.join(",")}]`],
  );

  return result.rows;
}

/** Identifies a chunk across result lists. */
const chunkKey = (chunk: RetrievedChunk) => `${chunk.documentId}:${chunk.chunkIndex}`;

/**
 * Reciprocal Rank Fusion: every list gives a chunk 1 / (k + rank); chunks found
 * by several searches, or ranked high in one, come first. Uses ranks only, so
 * vector distances and keyword scores never need to be on the same scale.
 */
export function fuseRankings(
  lists: RetrievedChunk[][],
  k: number = config.rag.rrfK,
): RetrievedChunk[] {
  const scores = new Map<string, { chunk: RetrievedChunk; score: number }>();

  for (const list of lists) {
    list.forEach((chunk, index) => {
      const entry = scores.get(chunkKey(chunk)) ?? { chunk, score: 0 };
      entry.score += 1 / (k + index + 1);
      scores.set(chunkKey(chunk), entry);
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.chunk);
}

/**
 * Search candidates for a question: vector search, plus keyword search fused
 * with RRF when hybrid search is on. Keyword hits skip the distance cutoff,
 * since an exact term match is evidence of its own.
 */
export async function searchCandidates(
  userId: number,
  question: string,
  limit: number,
  documentId?: number,
  maxDistance: number = config.rag.maxCosineDistance,
): Promise<RetrievedChunk[]> {
  checkLimit(limit);
  const embedding = await generateEmbedding(question);
  const vectorHits = await vectorSearch(userId, embedding, limit, documentId, maxDistance);

  if (!config.rag.hybridSearch) return vectorHits;

  const keywordHits = await keywordSearch(userId, question, embedding, limit, documentId);
  return fuseRankings([vectorHits, keywordHits]).slice(0, limit);
}

/** Chunks by position, plus every chunk of the given sections. */
async function getNeighbours(
  documentId: number,
  chunkIndexes: number[],
  sectionIndexes: number[],
): Promise<ContextChunk[]> {
  if (chunkIndexes.length === 0 && sectionIndexes.length === 0) return [];

  const result = await pool.query<ContextChunk>(
    `SELECT
       dc.document_id AS "documentId",
       d.filename,
       dc.page_number AS "pageNumber",
       dc.page_end AS "pageEnd",
       dc.chunk_index AS "chunkIndex",
       dc.section_index AS "sectionIndex",
       dc.content,
       false AS "isHit"
     FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     WHERE dc.document_id = $1
       AND (dc.chunk_index = ANY($2::int[]) OR dc.section_index = ANY($3::int[]))`,
    [documentId, chunkIndexes, sectionIndexes],
  );

  return result.rows;
}

/** A neighbour belongs to a hit when it is next to it or in the same section. */
function belongsTo(chunk: ContextChunk, hit: ContextChunk): boolean {
  return (
    Math.abs(chunk.chunkIndex - hit.chunkIndex) === 1 ||
    (hit.sectionIndex != null && chunk.sectionIndex === hit.sectionIndex)
  );
}

/**
 * Combines ranked hits with their neighbours: hits always come first, then
 * neighbours of the best-ranked hit (closest first), then of the next hit,
 * until `cap` chunks are used. The result is de-duplicated and in reading order.
 */
export function mergeContext(
  hits: ContextChunk[],
  neighbours: ContextChunk[],
  cap: number,
): ContextChunk[] {
  const chosen = new Map<number, ContextChunk>();

  for (const chunk of hits) {
    if (chosen.size >= cap) break;
    chosen.set(chunk.chunkIndex, chunk);
  }

  // Lower is better: rank of the hit it belongs to, then distance from that hit.
  const priority = (chunk: ContextChunk): number => {
    const scores = hits
      .map((hit, rank) =>
        belongsTo(chunk, hit) ? rank * 10_000 + Math.abs(chunk.chunkIndex - hit.chunkIndex) : null,
      )
      .filter((score): score is number => score !== null);

    return scores.length > 0 ? Math.min(...scores) : Number.MAX_SAFE_INTEGER;
  };

  const ranked = [...neighbours].sort((a, b) => priority(a) - priority(b));

  for (const chunk of ranked) {
    if (chosen.size >= cap) break;
    if (!chosen.has(chunk.chunkIndex)) chosen.set(chunk.chunkIndex, chunk);
  }

  return [...chosen.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/**
 * The context sent to the model for focused / multi-part questions:
 * the most similar chunks plus the chunks right before and after them, and
 * for slide decks the other slides of the same section.
 */
/**
 * Search candidates ordered best first (reranked when the reranker is on).
 * Independent of the retrieval mode, so it can start before the router decides.
 */
export async function rankedCandidates(
  userId: number,
  question: string,
  documentId: number,
): Promise<RetrievedChunk[]> {
  // With a reranker: fetch more candidates and let it pick the best.
  const limit = config.reranker.enabled
    ? Math.max(config.rag.retrievalLimits.multi_part, config.reranker.candidates)
    : config.rag.retrievalLimits.multi_part;
  const candidates = await searchCandidates(userId, question, limit, documentId);
  return rerankChunks(question, candidates);
}

/**
 * Drops hits the reranker judged irrelevant. Chunks without a score (reranker
 * off or down) are kept, so a reranker failure never hides results.
 */
export function relevantHits(
  ranked: RetrievedChunk[],
  minScore: number | null = config.reranker.minScore,
): RetrievedChunk[] {
  if (minScore === null) return ranked;
  return ranked.filter((chunk) => chunk.rerankScore === undefined || chunk.rerankScore >= minScore);
}

export async function retrieveContext(
  userId: number,
  question: string,
  mode: ContextMode,
  documentId: number,
  /** Candidates already ranked for this question and document (fetched early). */
  ranked?: RetrievedChunk[],
): Promise<ContextChunk[]> {
  const hits = relevantHits(ranked ?? (await rankedCandidates(userId, question, documentId)))
    .slice(0, config.rag.retrievalLimits[mode])
    .map((hit) => ({ ...hit, isHit: true }));

  if (hits.length === 0) return [];

  const hitIndexes = new Set(hits.map((hit) => hit.chunkIndex));
  const wanted = new Set<number>();

  for (const hit of hits) {
    for (const index of [hit.chunkIndex - 1, hit.chunkIndex + 1]) {
      if (index >= 0 && !hitIndexes.has(index)) wanted.add(index);
    }
  }

  const sections = config.rag.sectionExpansion
    ? [...new Set(hits.map((hit) => hit.sectionIndex).filter((s): s is number => s != null))]
    : [];

  const neighbours = (await getNeighbours(documentId, [...wanted], sections)).filter(
    (chunk) => !hitIndexes.has(chunk.chunkIndex),
  );

  return mergeContext(hits, neighbours, config.rag.maxContextChunks[mode]);
}
