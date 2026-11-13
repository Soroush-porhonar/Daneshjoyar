import { buildTransformPrompt, RAG_SYSTEM_PROMPT } from "../llm/prompts/rag.js";
import { SOURCES_HEADING } from "../messages.js";
import type { AnswerTrace } from "./answer.js";
import { appendSources, formatChunks, generate, numberSources } from "./answer.js";
import { getChunksByRef } from "./retrieve.js";
import type { ChunkRef } from "./retrieve.js";
import { normalizeText } from "./textQuality.js";

/** Longer messages carry a new question of their own, not just a change of form. */
const MAX_TRANSFORM_LENGTH = 50;

const NUMBER = "(?:یک|یه|دو|سه|چهار|پنج|شش|[1-9]|[۱-۹])";

/**
 * Requests to change the form of the previous answer: shorter, simpler, in N
 * sentences, as a list. "Give an example" or "explain more" are not here: they
 * ask for more content from the notes, so they stay follow-ups (searched).
 */
const TRANSFORM_PATTERNS = [
  // "کوتاه‌ترش کن", "ساده‌تر بگو" (but not a comparison: "کدوم ساده‌تره؟").
  /(?:کوتاه|ساده|مختصر|خلاصه|راحت|واضح|روان)\s*تر\s*(?:ش|اش)?\s*(?:کن|بگو|توضیح|بنویس|بده|$)/,
  // "در سه جمله", "یه خلاصه سه جمله‌ای".
  new RegExp(
    `(?:در|تو|توی|با|خلاصه)\\s*(?:ی\\s*)?${NUMBER}\\s*(?:تا\\s*)?(?:جمله|خط|بند|پاراگراف)|${NUMBER}\\s*(?:جمله|خط|بند)\\s*(?:ای|ی)(?:\\s|$|[؟?.!،])`,
  ),
  /به\s*زبان\s*(?:ساده|خودمونی|عامیانه)/,
  /(?:لیست|فهرست|نکته|تیتر)\s*(?:وار|ی)?\s*(?:کن|بنویس|بگو)/,
  /به\s*صورت\s*(?:لیست|فهرست|نکته|جدول|خلاصه)/,
];

/** True for a short request to reshape the previous answer ("کوتاه‌ترش کن", "در سه جمله"). */
export function isTransformRequest(text: string): boolean {
  const normalized = normalizeText(text).replace(/‌/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_TRANSFORM_LENGTH && TRANSFORM_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** The previous answer without its sources list and citation numbers (they are renumbered). */
export function previousAnswerBody(answer: string): string {
  return answer
    .split(SOURCES_HEADING)[0]!
    .replace(/\s*\[[\d\s,،]+\]/g, "")
    .trim();
}

/**
 * Rewrites the previous answer as asked, from that answer's own sources: no
 * new search, and never a whole-document summary (both happened to "shorter"
 * and "in three sentences" before, roadmap 3.1). Cited like a normal answer.
 */
export async function answerTransform(
  userId: number,
  request: string,
  previousAnswer: string,
  sources: ChunkRef[],
  { signal, trace }: { signal?: AbortSignal; trace?: AnswerTrace } = {},
): Promise<string> {
  const chunks = await getChunksByRef(userId, sources);
  const numbers = numberSources(chunks);

  if (trace) {
    trace.context = chunks;
    trace.documentIds = [...new Set(chunks.map((chunk) => chunk.documentId))];
  }

  const answer = await generate(
    RAG_SYSTEM_PROMPT,
    buildTransformPrompt(request, previousAnswerBody(previousAnswer), formatChunks(chunks, numbers)),
    signal,
    trace,
  );

  return appendSources(answer, chunks, numbers);
}
