import { config } from "../config.js";
import { getDocumentProfile, listCompletedDocuments } from "../db/documents.js";
import { buildDocumentInfoPrompt, RAG_SYSTEM_PROMPT } from "../llm/prompts/rag.js";
import { documentDisplayName, documentInfoHeaderText, NO_DOCUMENT_CONTENT_TEXT } from "../messages.js";
import type { AnswerOptions } from "./answer.js";
import { formatChunks, generate, pickDocument } from "./answer.js";
import { getDocumentChunks } from "./retrieve.js";
import { normalizeText } from "./textQuality.js";
import type { ContextChunk } from "./retrieve.js";

/** Chunks of the opening page given to the model: title page, author, contents. */
const OPENING_CHUNKS = 3;

const DOCUMENT = "(?:جزوه|فایل|متن|پی\\s*دی\\s*اف|pdf|کتاب|سند|عکس)";
const THIS = "(?:این|اون|آن)";
const WHAT = "(?:چیه|چیست|چی\\s*هست|چی\\s*است|چه\\s*چیزی\\s*(?:است|هست))";

/**
 * Questions about a document itself, as students write them: what it is about
 * ("این جزوه راجع به چیه؟", or just "درباره چیه"), who wrote it ("نویسنده این
 * متن کیه؟", "این جزوه مال کیست؟"), its topics ("سرفصل‌های این جزوه"). A
 * question about a topic inside the notes ("این جزوه درباره هافمن چی می‌گه؟",
 * "نویسنده درباره رسانه‌ها چه می‌گوید؟") must not match.
 */
const DOCUMENT_INFO_PATTERNS = [
  // What it is about: "about" directly followed by "what", optionally after "this handout".
  new RegExp(`^(?:${THIS}\\s*${DOCUMENT}\\s*)?(?:راجع\\s*به|درباره|در\\s*مورد)\\s*${WHAT}`),
  new RegExp(`اطلاعات\\s*کلی\\s*(?:درباره|راجع\\s*به|در\\s*مورد|از)?\\s*${THIS}\\s*${DOCUMENT}`),
  new RegExp(`${THIS}\\s*${DOCUMENT}\\s*(?:راجع\\s*به|درباره|در\\s*مورد)\\s*${WHAT}`),
  // Who wrote it.
  new RegExp(`(?:نویسنده|نگارنده|مؤلف|مولف|استاد)\\s*(?:ی\\s*)?${THIS}\\s*${DOCUMENT}`),
  new RegExp(`${THIS}\\s*${DOCUMENT}\\s*(?:مال|نوشته|اثر|برای)\\s*(?:ی\\s*)?(?:کی|چه\\s*کسی)`),
  // Its topics.
  // (The half-space in "سرفصل‌های" is read as a space, so the plural is its own word.)
  new RegExp(`(?:سرفصل|مباحث|موضوعات|فهرست|عناوین)(?:\\s*(?:های|ها))?\\s*${THIS}\\s*${DOCUMENT}`),
  new RegExp(`${THIS}\\s*${DOCUMENT}\\s*(?:چه|چی)\\s*(?:مباحثی|موضوعاتی|سرفصل|فصل)`),
];

/** True for a question about a document itself (answered from its profile, without the router). */
export function isDocumentInfoQuestion(text: string): boolean {
  const normalized = normalizeText(text).replace(/‌/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return DOCUMENT_INFO_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Answers a question about a document itself ("what is this handout about",
 * "who wrote it", "what are its topics") from its stored profile (title,
 * summary, topics from enrichment) and its opening page, with no search: a
 * search for "who wrote this" finds nothing (1 of 6 such messages routed
 * right, 2026-11-12). No inline citations: given the opening page as source
 * [1], the model also cited it for facts from the whole-file summary
 * (eval:answers info-lisbon-about, 2026-11-13); the header names the file.
 */
export async function answerDocumentInfo(
  userId: number,
  question: string,
  { signal, prefetch, trace, documentId }: AnswerOptions = {},
): Promise<string> {
  const documents = (await listCompletedDocuments(userId)).filter(
    (document) => documentId === undefined || document.id === documentId,
  );
  const early = await prefetch?.catch(() => null);
  const document = pickDocument(documents, question, early?.ranked ?? []);
  if (!document) return NO_DOCUMENT_CONTENT_TEXT;

  const [profile, chunks] = await Promise.all([
    getDocumentProfile(userId, document.id),
    getDocumentChunks(userId, document.id),
  ]);
  // Chunks are ordered by page, so the first ones are the opening page(s).
  const opening: ContextChunk[] = chunks
    .slice(0, OPENING_CHUNKS)
    .map((chunk) => ({ ...chunk, isHit: true }));

  if (trace) {
    trace.documentIds = [document.id];
    trace.context = opening;
  }

  const name = documentDisplayName(document.filename, document.title);
  const answer = await generate(
    RAG_SYSTEM_PROMPT,
    buildDocumentInfoPrompt(question, name, profile, formatChunks(opening)),
    signal,
    trace,
    config.llm.maxTokens.focused,
  );

  // A citation marker the model writes anyway would point nowhere.
  const body = answer.replace(/\s*\[[\d\s,،]+\]/g, "").trim();
  return `${documentInfoHeaderText(name)}\n\n${body}`;
}
