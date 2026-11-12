/**
 * Citation check: is the source an answer cites as [n] about what the
 * sentence says? Scored by the cross-encoder reranker (already running on the
 * CPU), which reads the sentence and the source together.
 *
 * It is a topic check, not a faithfulness check. Measured on 30 hand-labelled
 * pairs (eval/citation-labels.json, npm run eval:citations): on the 22 pairs
 * taken from real answers it does not tell supported from unsupported
 * citations (AUC 0.55; unsupported claims scored up to 2.6, correct ones on
 * garbled OCR text down to -6.8), but all 8 pairs whose source came from
 * another document scored -4.97 or lower. The cross-encoder judges relevance,
 * not whether the source states the claim. Whether an answer invents facts is
 * still unmeasured; that needs a stronger judge model.
 */
import { numberSources, sourceLine } from "../src/rag/answer.js";
import { scoreTexts } from "../src/rag/rerank.js";
import { citedSentences } from "./answerChecks.js";

/**
 * A citation scoring below this cites a source about something else. Set
 * between the mismatched pairs (at most -4.97) and the unsupported pairs from
 * real answers (at least -4.56); it still rejects 2 of 16 correct citations,
 * both on garbled OCR text (-5.5, -6.8). Re-measure with npm run eval:citations.
 */
export const CITATION_SUPPORT_SCORE = -5;

/** A source as the model saw it: its number, its line in the sources list, and its chunks' text. */
export interface NumberedSource {
  number: number;
  line: string;
  chunks: string[];
}

export interface CitationCheck {
  sentence: string;
  number: number;
  /** False when the answer cites a number that was not among its sources. */
  known: boolean;
  /** The best score of the sentence against the source's chunks; null if it could not be scored. */
  score: number | null;
}

interface ContextChunk {
  filename: string;
  documentTitle?: string | null;
  pageNumber: number | null;
  pageEnd?: number | null;
  content: string;
}

/** The numbered sources of a context, exactly as the answer prompt numbers them. */
export function numberedSources(context: ContextChunk[]): NumberedSource[] {
  return [...numberSources(context)].map(([line, number]) => ({
    number,
    line,
    chunks: context.filter((chunk) => sourceLine(chunk) === line).map((chunk) => chunk.content),
  }));
}

/** How well a source supports a sentence: the best score over its chunks (null: reranker off or down). */
export async function supportScore(sentence: string, chunks: string[]): Promise<number | null> {
  const scores = await scoreTexts(sentence, chunks);
  return scores ? Math.max(...scores) : null;
}

/** Every (sentence, cited source) pair of an answer's body, scored. */
export async function checkCitations(body: string, sources: NumberedSource[]): Promise<CitationCheck[]> {
  const checks: CitationCheck[] = [];

  for (const { sentence, numbers } of citedSentences(body)) {
    for (const number of numbers) {
      const source = sources.find((candidate) => candidate.number === number);
      checks.push({
        sentence,
        number,
        known: source !== undefined,
        score: source ? await supportScore(sentence, source.chunks) : null,
      });
    }
  }

  return checks;
}

/** True / false, or null when the pair could not be scored (reranker down). */
export function isSupported(check: CitationCheck, threshold: number = CITATION_SUPPORT_SCORE): boolean | null {
  if (!check.known) return false;
  return check.score === null ? null : check.score >= threshold;
}
