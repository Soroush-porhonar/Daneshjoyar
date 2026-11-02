import { config } from "../config.js";
import { logger } from "../logger.js";
import { getSelectedDocumentId } from "../db/conversations.js";
import {
  NO_DOCUMENT_CONTENT_TEXT,
  NO_DOCUMENT_SELECTED_TEXT,
  NO_RELEVANT_CONTENT_TEXT,
  SOURCES_HEADING,
  sourceLineText,
} from "../messages.js";
import { chat } from "../llm/ollamaClient.js";
import {
  BROAD_EXTRACTION_SYSTEM_PROMPT,
  RAG_SYSTEM_PROMPT,
  buildBatchExtractionPrompt,
  buildBroadSynthesisPrompt,
  buildFocusedUserPrompt,
} from "../llm/prompts/rag.js";
import { batchByChars } from "./batch.js";
import { getDocumentChunks, rankedCandidates, retrieveContext } from "./retrieve.js";
import type { ChunkRef, ContextChunk, RetrievedChunk } from "./retrieve.js";
import type { RetrievalMode } from "./router.js";

interface SourceChunk {
  filename: string;
  pageNumber: number | null;
  pageEnd?: number | null;
  content: string;
  /** False for neighbour chunks, which are context but not cited. */
  isHit?: boolean;
}

const GENERATION_OPTIONS = {
  num_predict: 4096,
  temperature: config.llm.temperature.rag,
};

function generate(
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  return chat({
    think: false,
    options: GENERATION_OPTIONS,
    signal,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
}

/** The source line a chunk is cited as; chunks on the same page share it. */
const sourceLine = (chunk: SourceChunk): string | null =>
  chunk.pageNumber == null ? null : sourceLineText(chunk.filename, chunk.pageNumber, chunk.pageEnd);

/** Numbers the distinct sources (pages) in reading order: source line -> 1, 2, ... */
export function numberSources(chunks: SourceChunk[]): Map<string, number> {
  const numbers = new Map<string, number>();

  for (const chunk of chunks) {
    const line = sourceLine(chunk);
    if (line !== null && !numbers.has(line)) numbers.set(line, numbers.size + 1);
  }

  return numbers;
}

/** With `numbers`, each chunk is labelled with its source number so the model can cite it as [n]. */
export function formatChunks(chunks: SourceChunk[], numbers?: Map<string, number>): string {
  return chunks
    .map((chunk) => {
      const number = numbers?.get(sourceLine(chunk) ?? "");

      return `[${number ? `منبع ${number} — ` : ""}فایل: ${chunk.filename}، صفحه PDF ${chunk.pageNumber ?? "نامشخص"}${
        chunk.pageEnd && chunk.pageNumber && chunk.pageEnd > chunk.pageNumber
          ? ` تا ${chunk.pageEnd}`
          : ""
      }]\n${chunk.content}`;
    })
    .join("\n\n---\n\n");
}

export function buildSourceList(chunks: SourceChunk[]): string[] {
  return [
    ...new Set(
      chunks
        .filter((chunk) => chunk.isHit !== false)
        .map(sourceLine)
        .filter((line): line is string => line !== null),
    ),
  ];
}

const toAsciiDigits = (text: string) =>
  text.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));

/**
 * The source numbers the model cited inline: [2], [1][3], [1، 3], [۲].
 * Code (a[1], a[1][2]) is not a citation.
 */
export function citedNumbers(answer: string): Set<number> {
  const cited = new Set<number>();
  const prose = toAsciiDigits(answer).replace(/```[\s\S]*?```|`[^`\n]*`/g, "");

  // A run of brackets ("[1][3]") counts only when it doesn't follow a name or a bracket.
  for (const [run] of prose.matchAll(/(?<![\w)\]])(?:\[[\d\s,،]+\])+/g)) {
    for (const part of run.split(/[^\d]+/)) {
      if (part) cited.add(Number(part));
    }
  }

  return cited;
}

/** Phrases of an answer saying the sources don't cover the question (also used by eval:answers). */
export const REFUSAL_PATTERN =
  /(پیدا نکردم|اطلاعاتی (در|درباره)|وجود ندارد|نیامده|اشاره‌ای نشده|ذکر نشده|کافی نیست|در منابع .*نیست)/;

/**
 * The answer says the sources don't cover the question. Judged by its first
 * sentence: a refusal opens with it ("the sources say nothing about X"), and
 * may then cite what the sources do cover; a partial answer opens with content.
 */
export function isRefusal(answer: string): boolean {
  const first = answer.trim().split(/[.؟?!\n]/)[0] ?? "";

  return (
    answer === NO_RELEVANT_CONTENT_TEXT ||
    (REFUSAL_PATTERN.test(first) && /منابع|منبع|جزوه|متن/.test(first) && citedNumbers(first).size === 0)
  );
}

/**
 * Adds the sources section. With `numbers`, only the sources the model cited
 * inline are listed, numbered like in the answer; if it cited none, the real
 * hits are listed. A refusal gets no sources: nothing was taken from them.
 */
export function appendSources(
  answer: string,
  chunks: SourceChunk[],
  numbers?: Map<string, number>,
): string {
  if (isRefusal(answer)) return answer;

  const cited = numbers ? citedNumbers(answer) : new Set<number>();
  const used = [...(numbers ?? [])].filter(([, number]) => cited.has(number));
  const sources =
    used.length > 0
      ? used.map(([line, number]) => `[${number}] ${line}`)
      : buildSourceList(chunks).map((line) => {
          const number = numbers?.get(line);
          return number ? `[${number}] ${line}` : line;
        });

  if (sources.length === 0) {
    return answer;
  }

  return `${answer}\n\n${SOURCES_HEADING}\n${sources
    .map((source) => `- ${source}`)
    .join("\n")}`;
}

/** Pages the broad-mode batch summaries refer to ("صفحه PDF 12", "صفحه ۱۲ تا ۱۴"). */
export function pagesMentioned(summaries: string[]): Set<number> {
  const pages = new Set<number>();

  for (const match of toAsciiDigits(summaries.join("\n")).matchAll(
    /صفحه(?:‌های| های|ات)?(?: PDF)?\s*(\d+)(?:\s*(?:تا|-)\s*(\d+))?/g,
  )) {
    const first = Number(match[1]);
    const last = Math.min(Number(match[2] ?? match[1]), first + 50);
    for (let page = first; page <= last; page++) pages.add(page);
  }

  return pages;
}

async function answerBroadQuestion(
  userId: number,
  documentId: number,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const chunks = await getDocumentChunks(userId, documentId);

  if (chunks.length === 0) {
    return NO_DOCUMENT_CONTENT_TEXT;
  }

  const summaries: string[] = [];

  for (const [index, batch] of batchByChars(
    chunks,
    config.rag.broadBatchChars,
  ).entries()) {
    const batchNumber = index + 1;

    const summary = await generate(
      BROAD_EXTRACTION_SYSTEM_PROMPT,
      buildBatchExtractionPrompt(question, formatChunks(batch)),
      signal,
    );

    summaries.push(`خلاصه بخش ${batchNumber}:\n${summary}`);
    logger.debug(`[RAG] Batch ${batchNumber} summary:\n${summary}`);
  }

  const answer = await generate(
    RAG_SYSTEM_PROMPT,
    buildBroadSynthesisPrompt(question, summaries),
    signal,
  );

  // Cite the pages the summaries drew on, not every page of the document.
  const mentioned = pagesMentioned(summaries);
  const cited = chunks.filter((chunk) => chunk.pageNumber != null && mentioned.has(chunk.pageNumber));

  return appendSources(answer, cited.length > 0 ? cited : chunks);
}

async function answerFocusedQuestion(
  userId: number,
  documentId: number,
  question: string,
  mode: "focused" | "multi_part",
  signal?: AbortSignal,
  ranked?: RetrievedChunk[],
  trace?: AnswerTrace,
): Promise<string> {
  const chunks = await retrieveContext(userId, question, mode, { documentId, ...(ranked ? { ranked } : {}) });

  if (trace) trace.context = chunks;

  if (chunks.length === 0) {
    return NO_RELEVANT_CONTENT_TEXT;
  }

  const numbers = numberSources(chunks);
  const answer = await generate(
    RAG_SYSTEM_PROMPT,
    buildFocusedUserPrompt(question, formatChunks(chunks, numbers)),
    signal,
  );

  return appendSources(answer, chunks, numbers);
}

/** Filled in while answering, for the answer log. */
export interface AnswerTrace {
  documentId?: number | null;
  /** The chunks the model was given (empty for whole-document summaries). */
  context?: ContextChunk[];
}

/** Search results fetched early, while the router was still deciding. */
export interface Prefetch {
  question: string;
  documentId: number | null;
  ranked: RetrievedChunk[];
}

/**
 * Starts searching the selected document right away, in parallel with the
 * router (search and reranking run on the CPU, the router on the GPU).
 * The result is simply ignored if the message turns out to be chat.
 * For a follow-up, `previous` (the last answer's hits) is reranked together
 * with the search results.
 */
export function prefetchCandidates(
  userId: number,
  question: string,
  previous?: ChunkRef[] | null,
): Promise<Prefetch> {
  const prefetch = (async () => {
    const documentId = await getSelectedDocumentId(userId);
    const ranked =
      documentId === null
        ? []
        : await rankedCandidates(userId, question, { documentId, include: previous ?? [] });
    return { question, documentId, ranked };
  })();

  // Not every prefetch is awaited (chat messages); avoid unhandled rejections.
  prefetch.catch(() => {});
  return prefetch;
}

/** Answers from the user's selected document. */
export async function answerFromDocuments(
  userId: number,
  question: string,
  retrievalMode: RetrievalMode = "multi_part",
  signal?: AbortSignal,
  prefetch?: Promise<Prefetch>,
  trace?: AnswerTrace,
): Promise<string> {
  // Use early results only if they were fetched for this exact question;
  // if fetching them failed, search again normally.
  const early = await prefetch?.catch(() => null);
  const usable = early?.question === question ? early : null;
  const documentId = usable ? usable.documentId : await getSelectedDocumentId(userId);

  if (trace) trace.documentId = documentId;

  if (documentId === null) {
    return NO_DOCUMENT_SELECTED_TEXT;
  }

  return answerFromDocument(userId, documentId, question, retrievalMode, signal, usable?.ranked, trace);
}

/** Answers from one specific document (also used by the answer eval). */
export async function answerFromDocument(
  userId: number,
  documentId: number,
  question: string,
  retrievalMode: RetrievalMode,
  signal?: AbortSignal,
  ranked?: RetrievedChunk[],
  trace?: AnswerTrace,
): Promise<string> {
  if (retrievalMode === "broad") {
    return answerBroadQuestion(userId, documentId, question, signal);
  }

  return answerFocusedQuestion(
    userId,
    documentId,
    question,
    retrievalMode,
    signal,
    ranked,
    trace,
  );
}
