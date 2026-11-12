/**
 * The scripted checks of eval:answers, as pure functions of an answer's text,
 * so a live run and a re-score of a saved run (--rescore) judge the same way.
 */
import { NO_RELEVANT_CONTENT_TEXT, SOURCES_HEADING } from "../src/messages.js";
import { REFUSAL_PATTERN, citedNumbers } from "../src/rag/answer.js";
import { plainMath } from "../src/rag/plainMath.js";
import { normalizeText } from "../src/rag/textQuality.js";
import { citedPages } from "./evalHelpers.js";

/** A fact the answer must contain: one spelling, or several accepted ones (synonyms, Persian and English). */
export type Keyword = string | string[];

export interface AnswerQuestion {
  id: string;
  type: string;
  filename: string;
  expectedPages: number[];
  mustInclude?: Keyword[];
}

/** An answer with less Persian than this (of its Persian + Latin letters) fails. */
export const MIN_PERSIAN_SHARE = 0.4;

/** Superscript then subscript digits, each at its value's index (mod 10). */
const SCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉";
const SCRIPT_DIGIT = new RegExp(`[${SCRIPT_DIGITS}]`, "g");

/**
 * Makes keyword matching tolerant of spacing, half-spaces, digit scripts and
 * formula markup: "$O(n \log n)$", "O(n log n)" and "nlogn" compare equal.
 * Formulas go through plainMath like the bot's own messages; LaTeX left
 * outside math delimiters loses its markup but keeps its letters.
 */
export function comparable(text: string): string {
  return normalizeText(plainMath(text))
    .toLowerCase()
    .replace(/\\(?:left|right|displaystyle|text|mathrm|mathbf|mathit|operatorname)(?![a-z])/g, "")
    .replace(/[$\\{}]/g, "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(SCRIPT_DIGIT, (digit) => String(SCRIPT_DIGITS.indexOf(digit) % 10))
    .replace(/ⁿ/g, "n")
    .replace(/[\s‌^]/g, "");
}

/** The `mustInclude` entries (named by their first form) of which no accepted form is in the answer. */
export function missingKeywords(body: string, mustInclude: Keyword[] = []): string[] {
  const text = comparable(body);

  return mustInclude
    .map((entry) => [entry].flat())
    .filter((forms) => !forms.some((form) => text.includes(comparable(form))))
    .map((forms) => forms[0]!);
}

/**
 * Share of Persian letters among the Persian and Latin letters of the prose.
 * Code, formulas and parenthesised Latin terms ("(Behavior Driven
 * Development)", "(C#)") are left out: a Persian answer listing English tool
 * names is still a Persian answer.
 */
export function persianShare(text: string): number {
  const prose = text
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, " ")
    .replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, " ")
    .replace(/\([^()؀-ۿ]*[A-Za-z][^()؀-ۿ]*\)/g, " ");
  const persian = (prose.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length;

  return persian / Math.max(persian + latin, 1);
}

/** A sentence of an answer and the source numbers it cites. */
export interface CitedSentence {
  /** The sentence without its citation marks, list marker and bold marks. */
  sentence: string;
  numbers: number[];
}

/** A run of citation marks: "[2]", "[1][3]", "[1، 3]", "[2]، [3]". */
const CITATION_RUN = /(?:\[[\d۰-۹\s,،]+\](?:\s*[،,]\s*)?)+/g;
const LIST_MARKER = /^\s*(?:[-*•]\s+|[\d۰-۹]+\s*[.)]\s+)/;

/**
 * The sentences of an answer that cite a source, for checking each citation
 * against its source. A line is split at sentence ends; a citation written
 * after the full stop ("... است. [2]") belongs to the sentence before it.
 * Sentences too short to be a claim (a heading with a citation) are skipped.
 */
export function citedSentences(body: string, minLength = 15): CitedSentence[] {
  const sentences: string[] = [];

  for (const line of body.split("\n")) {
    const text = line.replace(LIST_MARKER, "").trim();
    if (!text) continue;

    // Cut after . ؟ ? ! when a space follows (so "1.5" and "a.b" stay whole).
    for (const part of text.split(/(?<=[.؟?!])\s+/)) {
      const leading = new RegExp(`^(?:${CITATION_RUN.source})\\s*[.]?\\s*`).exec(part);

      if (leading && sentences.length > 0) {
        sentences[sentences.length - 1] += ` ${leading[0].trim()}`;
        if (part.slice(leading[0].length).trim()) sentences.push(part.slice(leading[0].length));
      } else {
        sentences.push(part);
      }
    }
  }

  return sentences.flatMap((raw) => {
    const numbers = [...citedNumbers(raw)].sort((a, b) => a - b);
    const sentence = raw
      .replace(CITATION_RUN, " ")
      .replace(/\*\*|__/g, "")
      .replace(/\s+([.،؛:؟?!])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();

    return numbers.length > 0 && sentence.length >= minLength ? [{ sentence, numbers }] : [];
  });
}

/** A chunk of the context as the eval needs it. */
export interface PageSpan {
  documentId: number;
  pageNumber: number | null;
  pageEnd?: number | null;
}

/** True when any of the chunks is in the document and covers one of the pages (a chunk may cross a page break). */
export function coversPage(chunks: PageSpan[], documentId: number, pages: number[]): boolean {
  return chunks.some((chunk) => {
    if (chunk.documentId !== documentId || chunk.pageNumber === null) return false;
    const end = chunk.pageEnd ?? chunk.pageNumber;
    return pages.some((page) => page >= chunk.pageNumber! && page <= end);
  });
}

export interface AnswerScore {
  /** The sources list has an expected page of the right file (null for unanswerable questions). */
  cites: boolean | null;
  /** The model cited [n] inline (null when it refused, or for unanswerable questions). */
  inline: boolean | null;
  missing: string[];
  persian: number;
  refused: boolean;
  passed: boolean;
}

/** The scripted verdict on one answer (the bot's full reply, sources list included). */
export function scoreAnswer(question: AnswerQuestion, answer: string): AnswerScore {
  const body = answer.split(SOURCES_HEADING)[0]!;
  const negative = question.type === "negative";
  // The right page of the right file (other files may be cited too).
  const cites = negative
    ? null
    : citedPages(answer, question.filename).some((page) => question.expectedPages.includes(page));
  const missing = negative ? [] : missingKeywords(body, question.mustInclude);
  const refused = answer === NO_RELEVANT_CONTENT_TEXT || REFUSAL_PATTERN.test(body);
  const persian = persianShare(body);

  return {
    cites,
    inline: negative || refused ? null : citedNumbers(body).size > 0,
    missing,
    persian,
    refused,
    passed: negative ? refused : Boolean(cites) && missing.length === 0 && persian >= MIN_PERSIAN_SHARE,
  };
}
