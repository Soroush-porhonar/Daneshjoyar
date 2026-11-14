/**
 * Upload-time enrichment, run in the background once a document is usable:
 * 1. a stored summary per group of pages (the same batches summary requests
 *    used to make while the student waited),
 * 2. a profile from those summaries: a real title, a short summary, topics,
 * 3. per chunk: one sentence of context (embedded with the chunk, so a chunk
 *    like "it has three types" keeps its subject) and questions it answers
 *    (embedded too, so a student's question can match a question).
 * Every model call waits while a student's answer is running.
 */
import { config } from "../config.js";
import {
  loadDocumentForEnrichment,
  saveEnrichment,
} from "../db/enrichment.js";
import type { ChunkEnrichment, DocumentProfile, EnrichmentChunk, SectionSummary } from "../db/enrichment.js";
import { chat } from "../llm/ollamaClient.js";
import { PreemptedError, questionsIdle } from "../llm/scheduler.js";
import {
  CHUNK_CONTEXT_SYSTEM_PROMPT,
  PROFILE_SYSTEM_PROMPT,
  buildChunkContextPrompt,
  buildProfilePrompt,
  buildSectionSummaryPrompt,
} from "../llm/prompts/enrich.js";
import { BROAD_EXTRACTION_SYSTEM_PROMPT } from "../llm/prompts/rag.js";
import { logger } from "../logger.js";
import { formatChunks } from "./answer.js";
import { batchByChars, fitSummaries } from "./batch.js";
import { contextualText } from "./chunk.js";
import { generateEmbeddings } from "./embeddings.js";

const EMBED_BATCH_SIZE = 16;
/** Section summaries given to the profile call, at most (the context window is 8192 tokens). */
const PROFILE_INPUT_CHARS = 14_000;
/** Section summary given with each chunk, at most. */
const SECTION_CONTEXT_CHARS = 1_500;

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
  },
  required: ["title", "summary", "topics"],
};

const CHUNK_SCHEMA = {
  type: "object",
  properties: {
    context: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["context", "questions"],
};

/**
 * A background model call; the GPU queue runs it only when no question is
 * being answered (enrichmentWorker runs as "enrich"). A question that arrives
 * meanwhile interrupts it (PreemptedError); it runs again once questions are done.
 */
async function backgroundChat(
  system: string,
  user: string,
  options: { format?: Record<string, unknown>; numPredict: number },
  signal?: AbortSignal,
): Promise<string> {
  for (;;) {
    try {
      return await chat({
        think: false,
        ...(options.format ? { format: options.format } : {}),
        options: { temperature: 0.2, num_predict: options.numPredict },
        signal,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
    } catch (error: unknown) {
      if (!(error instanceof PreemptedError)) throw error;
      logger.info("[Enrich] Call interrupted by a question; retrying after it");
      await questionsIdle();
    }
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Validates the profile JSON; falls back to the filename rather than failing the document. */
export function parseProfile(output: string, filename: string): DocumentProfile {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    const topics = Array.isArray(value.topics) ? value.topics.map(text).filter(Boolean).slice(0, 10) : [];
    return {
      title: text(value.title) || filename.replace(/\.pdf$/i, ""),
      summary: text(value.summary),
      topics,
    };
  } catch {
    return { title: filename.replace(/\.pdf$/i, ""), summary: "", topics: [] };
  }
}

/** Validates a chunk's JSON; null when it is unusable (the chunk then stays as it was). */
export function parseChunkContext(output: string): { context: string; questions: string[] } | null {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    const context = text(value.context);
    const questions = Array.isArray(value.questions)
      ? value.questions.map(text).filter(Boolean).slice(0, 3)
      : [];
    return context ? { context, questions } : null;
  } catch {
    return null;
  }
}

async function summarizeSections(
  chunks: EnrichmentChunk[],
  filename: string,
  signal?: AbortSignal,
): Promise<{ sections: SectionSummary[]; sectionOf: Map<number, number> }> {
  const sections: SectionSummary[] = [];
  const sectionOf = new Map<number, number>();

  for (const [sectionIndex, batch] of batchByChars(chunks, config.rag.broadBatchChars).entries()) {
    const labelled = batch.map((chunk) => ({ ...chunk, filename }));
    const summary = await backgroundChat(
      BROAD_EXTRACTION_SYSTEM_PROMPT,
      buildSectionSummaryPrompt(formatChunks(labelled)),
      { numPredict: 1024 },
      signal,
    );
    const pages = batch.flatMap((chunk) => [chunk.pageNumber, chunk.pageEnd]).filter((page): page is number => page != null);

    sections.push({
      sectionIndex,
      pageStart: pages.length > 0 ? Math.min(...pages) : null,
      pageEnd: pages.length > 0 ? Math.max(...pages) : null,
      summary,
    });
    batch.forEach((chunk) => sectionOf.set(chunk.id, sectionIndex));
  }

  return { sections, sectionOf };
}

/** Enriches one document and stores the result (replacing an earlier enrichment). */
export async function enrichDocument(documentId: number, signal?: AbortSignal): Promise<void> {
  const document = await loadDocumentForEnrichment(documentId);
  if (!document || document.chunks.length === 0) throw new Error(`Document ${documentId} has no chunks to enrich`);

  const started = Date.now();
  const { chunks, filename } = document;
  logger.info(`[Enrich] Document ${documentId}: ${chunks.length} chunks`);

  const { sections, sectionOf } = await summarizeSections(chunks, filename, signal);

  const profile = parseProfile(
    await backgroundChat(
      PROFILE_SYSTEM_PROMPT,
      buildProfilePrompt(filename, fitSummaries(sections.map((s) => s.summary), PROFILE_INPUT_CHARS)),
      { format: PROFILE_SCHEMA, numPredict: 512 },
      signal,
    ),
    filename,
  );
  logger.info(`[Enrich] Document ${documentId}: ${sections.length} sections`);
  logger.debug(`[Enrich] Document ${documentId} title: "${profile.title}"`);

  const contexts: { chunk: EnrichmentChunk; context: string; questions: string[] }[] = [];

  for (const chunk of chunks) {
    const section = sections[sectionOf.get(chunk.id) ?? 0]?.summary ?? "";
    const parsed = parseChunkContext(
      await backgroundChat(
        CHUNK_CONTEXT_SYSTEM_PROMPT,
        buildChunkContextPrompt(profile.title, section.slice(0, SECTION_CONTEXT_CHARS), chunk.content),
        { format: CHUNK_SCHEMA, numPredict: 300 },
        signal,
      ),
    );

    if (parsed) contexts.push({ chunk, ...parsed });
    else logger.warn(`[Enrich] Document ${documentId}, chunk ${chunk.chunkIndex}: unusable context, skipped`);
  }

  // Embed the contextual chunks and the questions, in batches.
  const texts = contexts.flatMap(({ chunk, context, questions }) => [
    contextualText(profile.title, chunk.sectionTitle, context, chunk.content),
    ...questions,
  ]);
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    await questionsIdle();
    vectors.push(...(await generateEmbeddings(texts.slice(start, start + EMBED_BATCH_SIZE))));
  }

  let next = 0;
  const enriched: ChunkEnrichment[] = contexts.map(({ chunk, context, questions }) => {
    const contextEmbedding = vectors[next++]!;
    return {
      chunkId: chunk.id,
      context,
      contextEmbedding,
      questions: questions.map((question) => ({ question, embedding: vectors[next++]! })),
    };
  });

  await saveEnrichment(documentId, profile, sections, enriched);
  logger.info(
    `[Enrich] Document ${documentId} done in ${Math.round((Date.now() - started) / 1000)}s ` +
      `(${enriched.length}/${chunks.length} chunks with context)`,
  );
}
