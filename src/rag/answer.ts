import { config } from "../config.js";
import { logger } from "../logger.js";
import { listCompletedDocuments } from "../db/documents.js";
import { getSectionSummaries } from "../db/enrichment.js";
import type { CompletedDocument } from "../db/documents.js";
import { markCut } from "../llm/cut.js";
import {
  NO_DOCUMENT_CONTENT_TEXT,
  NO_RELEVANT_CONTENT_TEXT,
  SOURCES_HEADING,
  documentDisplayName,
  summaryHeaderText,
  sourceLineText,
} from "../messages.js";
import { isPhotoFilename } from "./documentKind.js";
import { chat } from "../llm/ollamaClient.js";
import type { ChatStats } from "../llm/ollamaClient.js";
import {
  BROAD_EXTRACTION_SYSTEM_PROMPT,
  RAG_SYSTEM_PROMPT,
  buildBatchExtractionPrompt,
  buildBroadSynthesisPrompt,
  buildFocusedUserPrompt,
} from "../llm/prompts/rag.js";
import { batchByChars, fitSummaries } from "./batch.js";
import { getDocumentChunks, rankedCandidates, retrieveContext } from "./retrieve.js";
import type { ChunkRef, ContextChunk, RetrievedChunk } from "./retrieve.js";
import type { RetrievalMode } from "./router.js";
import { normalizeText } from "./textQuality.js";

interface SourceChunk {
  filename: string;
  documentTitle?: string | null;
  pageNumber: number | null;
  pageEnd?: number | null;
  content: string;
  /** False for neighbour chunks, which are context but not cited. */
  isHit?: boolean;
}

/**
 * With a `trace`, the call's token counts and timings are recorded on it.
 * With a `limit` (a reply the student reads), output stops at that many tokens
 * and a cut-off answer ends with a line saying so; without one (an internal
 * batch summary) the summary cap applies and nothing is added.
 */
export async function generate(
  system: string,
  user: string,
  signal?: AbortSignal,
  trace?: AnswerTrace,
  limit?: number,
): Promise<string> {
  let doneReason: string | undefined;
  const answer = await chat({
    think: false,
    options: { num_predict: limit ?? config.llm.maxTokens.summary, temperature: config.llm.temperature.rag },
    signal,
    onStats: (stats) => {
      doneReason = stats.doneReason;
      if (trace) trace.generation = stats;
    },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return limit !== undefined ? markCut(answer, doneReason) : answer;
}

/**
 * The source line a chunk is cited as; chunks on the same page share it. A
 * photo is one page, cited by its name alone.
 */
export const sourceLine = (chunk: SourceChunk): string | null => {
  if (isPhotoFilename(chunk.filename)) return documentDisplayName(chunk.filename, chunk.documentTitle);
  return chunk.pageNumber == null ? null : sourceLineText(chunk.filename, chunk.pageNumber, chunk.pageEnd);
};

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

/**
 * Phrases of an answer saying the sources don't cover the question (also used by
 * eval:answers). The words between "اشاره‌ای به … نشده" and "توضیحی درباره … ندارد"
 * name the topic: 4 of 5 missed near-miss refusals on 2026-11-12 had them.
 */
export const REFUSAL_PATTERN =
  /(پیدا نکردم|اطلاعاتی (در|درباره)|وجود ندارد|نیامده|اشاره[‌ ]?ای (به .{0,150})?نشده|ذکر نشده|کافی نیست|در منابع .*نیست|توضیحی (درباره|در مورد|برای) .{0,150}(ندارد|ندارند|نشده)|نمی[‌ ]?توان(م)? .{0,60}پاسخ)/;

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

/** A run of citation brackets: [2], [1][3], [1، 3], [۲]; not after a name or bracket (code: a[1]). */
const CITATION_RUN = /(?<![\w)\]])(?:\[[\d۰-۹\s,،]+\])+/g;

/**
 * Renumbers the answer's citations 1..n in order of first appearance, so the
 * student sees [1], [2], [3] instead of the context's numbers with gaps
 * ([2], [4], [5], roadmap 2.4). Numbers that name no source are dropped from
 * the text. Code is left alone. Returns the text and old -> new numbers.
 */
export function renumberCitations(
  answer: string,
  known: Set<number>,
): { text: string; renumbered: Map<number, number> } {
  const renumbered = new Map<number, number>();
  for (const number of citedNumbers(answer)) {
    if (known.has(number)) renumbered.set(number, renumbered.size + 1);
  }

  const rewrite = (prose: string) =>
    prose.replace(CITATION_RUN, (run) => {
      const numbers = [...new Set(toAsciiDigits(run).split(/[^\d]+/).filter(Boolean).map(Number))];
      const kept = numbers
        .map((number) => renumbered.get(number))
        .filter((number): number is number => number !== undefined)
        .map((number) => `[${number}]`)
        .join("");
      // A dropped run leaves no gap before the punctuation that followed it.
      return kept || "\u0000";
    }).replace(/ *\u0000/g, "");

  // Odd parts are code (```…``` or `…`) and keep their brackets.
  const text = answer
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : rewrite(part)))
    .join("");

  return { text, renumbered };
}

/**
 * Adds the sources section. With `numbers`, only the sources the model cited
 * inline are listed, renumbered 1..n like the answer's citations; if it cited
 * none, the real hits are listed without numbers. A refusal gets no sources:
 * nothing was taken from them.
 */
export function appendSources(
  answer: string,
  chunks: SourceChunk[],
  numbers?: Map<string, number>,
): string {
  if (isRefusal(answer)) return answer;

  const lineOf = new Map([...(numbers ?? [])].map(([line, number]) => [number, line]));
  const { text, renumbered } = numbers
    ? renumberCitations(answer, new Set(lineOf.keys()))
    : { text: answer, renumbered: new Map<number, number>() };
  answer = text;

  const sources =
    renumbered.size > 0
      ? [...renumbered].map(([old, number]) => `[${number}] ${lineOf.get(old)!}`)
      : buildSourceList(chunks);

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
  document: CompletedDocument,
  question: string,
  signal?: AbortSignal,
  trace?: AnswerTrace,
): Promise<string> {
  const chunks = await getDocumentChunks(userId, document.id);

  if (chunks.length === 0) {
    return NO_DOCUMENT_CONTENT_TEXT;
  }

  // Enriched documents have the per-section summaries stored: one model call
  // instead of one per section. Others are summarised now (map-reduce).
  const stored = await getSectionSummaries(userId, document.id);
  const summaries: string[] =
    stored.length > 0
      ? fitSummaries(
          stored.map(
            (section) =>
              `خلاصه بخش ${section.sectionIndex + 1} (صفحه ${section.pageStart ?? "?"} تا ${section.pageEnd ?? "?"}):\n${section.summary}`,
          ),
          config.rag.storedSummaryChars,
        )
      : [];

  if (stored.length === 0) {
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
  }

  const answer = await generate(
    RAG_SYSTEM_PROMPT,
    buildBroadSynthesisPrompt(question, summaries),
    signal,
    trace,
    config.llm.maxTokens.summary,
  );

  // Cite the pages the summaries drew on, not every page of the document
  // (only the summaries' own text: the section labels name page ranges).
  const mentioned = pagesMentioned(stored.length > 0 ? stored.map((section) => section.summary) : summaries);
  const cited = chunks.filter((chunk) => chunk.pageNumber != null && mentioned.has(chunk.pageNumber));

  // Say which document was summarised: it was picked, not chosen by the student.
  return `${summaryHeaderText(documentDisplayName(document.filename, document.title))}\n\n${appendSources(answer, cited.length > 0 ? cited : chunks)}`;
}

async function answerFocusedQuestion(
  userId: number,
  question: string,
  mode: "focused" | "multi_part",
  scope: { documentId?: number; ranked?: RetrievedChunk[] },
  signal?: AbortSignal,
  trace?: AnswerTrace,
): Promise<string> {
  const chunks = await retrieveContext(userId, question, mode, scope);

  if (trace) {
    trace.context = chunks;
    trace.documentIds = [...new Set(chunks.filter((chunk) => chunk.isHit).map((chunk) => chunk.documentId))];
  }

  if (chunks.length === 0) {
    return NO_RELEVANT_CONTENT_TEXT;
  }

  const numbers = numberSources(chunks);
  const answer = await generate(
    RAG_SYSTEM_PROMPT,
    buildFocusedUserPrompt(question, formatChunks(chunks, numbers)),
    signal,
    trace,
    mode === "focused" ? config.llm.maxTokens.focused : config.llm.maxTokens.multiPart,
  );

  return appendSources(answer, chunks, numbers);
}

/** Filled in while answering, for the answer log. */
export interface AnswerTrace {
  /** The documents the answer drew on. */
  documentIds?: number[];
  /** The chunks the model was given (empty for whole-document summaries). */
  context?: ContextChunk[];
  /** Token counts and timings of the call that wrote the answer. */
  generation?: ChatStats;
}

/** Search results fetched early, while the router was still deciding. */
export interface Prefetch {
  question: string;
  ranked: RetrievedChunk[];
}

/**
 * Starts searching the user's documents right away, in parallel with the
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
  const prefetch = rankedCandidates(userId, question, { include: previous ?? [] }).then(
    (ranked) => ({ question, ranked }),
  );

  // Not every prefetch is awaited (chat messages); avoid unhandled rejections.
  prefetch.catch(() => {});
  return prefetch;
}

/** The text of a filename that a student might type: no extension, normalised. */
const comparableName = (filename: string) =>
  normalizeText(filename.replace(/\.pdf$/i, "")).toLowerCase().trim();

/** The longest of a document's title and topics that the question contains (0 if none). */
function profileMatch(document: CompletedDocument, text: string): number {
  return Math.max(
    0,
    ...[document.title, ...(document.topics ?? [])]
      .map((term) => (term ? normalizeText(term).toLowerCase() : ""))
      .filter((term) => term.length >= 3 && text.includes(term))
      .map((term) => term.length),
  );
}

/**
 * Which document a summary request is about, in this order: the only one; a
 * document whose name the question contains; a document whose title or a
 * topic the question contains (enriched documents); the document most of the
 * best search hits come from, when they clearly match; otherwise the newest upload.
 */
export function pickDocument(
  documents: CompletedDocument[],
  question: string,
  ranked: RetrievedChunk[],
): CompletedDocument | null {
  if (documents.length <= 1) return documents[0] ?? null;

  const text = normalizeText(question).toLowerCase();
  const named = documents
    .filter((document) => comparableName(document.filename).length >= 3)
    .filter((document) => text.includes(comparableName(document.filename)))
    .sort((a, b) => comparableName(b.filename).length - comparableName(a.filename).length);
  if (named[0]) return named[0];

  const [byProfile] = documents
    .map((document) => ({ document, match: profileMatch(document, text) }))
    .filter(({ match }) => match > 0)
    .sort((a, b) => b.match - a.match);
  if (byProfile) return byProfile.document;

  // Vote of the top hits (1/rank), only when the best one clearly matches the question.
  const top = ranked.slice(0, 5);
  if ((top[0]?.rerankScore ?? Number.NEGATIVE_INFINITY) >= config.reranker.relevantScore) {
    const votes = new Map<number, number>();
    top.forEach((chunk, rank) => votes.set(chunk.documentId, (votes.get(chunk.documentId) ?? 0) + 1 / (rank + 1)));
    const [bestId] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const voted = documents.find((document) => document.id === bestId);
    if (voted) return voted;
  }

  // documents is newest first.
  return documents[0]!;
}

export interface AnswerOptions {
  signal?: AbortSignal;
  /** Results searched early; used only if fetched for this exact question. */
  prefetch?: Promise<Prefetch>;
  trace?: AnswerTrace;
  /** Answer only from this document (the evals pin one version). */
  documentId?: number;
}

/** Answers from the user's documents: the most relevant chunks of any of them, or one picked document for summaries. */
export async function answerFromDocuments(
  userId: number,
  question: string,
  retrievalMode: RetrievalMode = "multi_part",
  { signal, prefetch, trace, documentId }: AnswerOptions = {},
): Promise<string> {
  // Use early results only if they were fetched for this exact question;
  // if fetching them failed, search again normally.
  const early = await prefetch?.catch(() => null);
  const ranked = early?.question === question ? early.ranked : undefined;

  if (retrievalMode === "broad") {
    const documents = (await listCompletedDocuments(userId)).filter(
      (document) => documentId === undefined || document.id === documentId,
    );
    const document = pickDocument(
      documents,
      question,
      ranked ?? (documents.length > 1 ? await rankedCandidates(userId, question) : []),
    );

    if (!document) return NO_DOCUMENT_CONTENT_TEXT;
    if (trace) trace.documentIds = [document.id];

    return answerBroadQuestion(userId, document, question, signal, trace);
  }

  return answerFocusedQuestion(
    userId,
    question,
    retrievalMode,
    { ...(documentId === undefined ? {} : { documentId }), ...(ranked ? { ranked } : {}) },
    signal,
    trace,
  );
}
