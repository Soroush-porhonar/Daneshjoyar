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
 * A list item is read with the line that introduces the list ("... has these
 * roles:"), since "Reader: reads the document" says nothing on its own.
 * Sentences too short to be a claim (a heading with a citation) are skipped.
 */
export function citedSentences(body: string, minLength = 15): CitedSentence[] {
  const sentences: { raw: string; lead?: string }[] = [];
  /** The last line outside a list that ends with ":" (it introduces the items below it). */
  let lead: string | undefined;

  for (const line of body.split("\n")) {
    const isItem = LIST_MARKER.test(line);
    const text = line.replace(LIST_MARKER, "").trim();
    if (!text) continue;

    if (!isItem) {
      const last = clean(text.split(/(?<=[.؟?!])\s+/).at(-1) ?? "");
      lead = /:$/.test(last) ? last : undefined;
    }

    // Cut after . ؟ ? ! when a space follows (so "1.5" and "a.b" stay whole).
    for (const part of text.split(/(?<=[.؟?!])\s+/)) {
      const leading = new RegExp(`^(?:${CITATION_RUN.source})\\s*[.]?\\s*`).exec(part);
      const rest = leading ? part.slice(leading[0].length) : part;

      if (leading && sentences.length > 0) sentences[sentences.length - 1]!.raw += ` ${leading[0].trim()}`;
      if (rest.trim()) sentences.push(isItem && lead ? { raw: rest, lead } : { raw: rest });
    }
  }

  return sentences.flatMap(({ raw, lead: intro }) => {
    const numbers = [...citedNumbers(raw)].sort((a, b) => a - b);
    const sentence = clean(raw);

    return numbers.length > 0 && sentence.length >= minLength
      ? [{ sentence: intro ? `${intro} ${sentence}` : sentence, numbers }]
      : [];
  });
}

/** Without citation marks, bold marks and doubled spaces. */
function clean(text: string): string {
  return text
    .replace(CITATION_RUN, " ")
    .replace(/\*\*|__/g, "")
    .replace(/\s+([.،؛:؟?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
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

/** A hand-labelled pair with the score a model gave it. */
export interface LabelledScore {
  score: number;
  supported: boolean;
}

export interface Separation {
  /** The cut-off (score >= threshold counts as supported) with the most labels right. */
  threshold: number;
  /** Share of the labels that cut-off gets right. */
  accuracy: number;
  /** Unsupported pairs scoring at or above the cut-off. */
  falsePositives: number;
  /** Supported pairs scoring below it. */
  falseNegatives: number;
  /**
   * Chance that a supported pair scores above an unsupported one (ties count
   * half): 1 = the scores separate the two groups fully, 0.5 = not at all.
   */
  auc: number;
}

/**
 * How well a score separates supported from unsupported pairs, and the best
 * cut-off: tried between every two neighbouring scores; among equally good
 * cut-offs, the one in the widest gap.
 */
export function separation(pairs: LabelledScore[]): Separation {
  const supported = pairs.filter((pair) => pair.supported).map((pair) => pair.score);
  const unsupported = pairs.filter((pair) => !pair.supported).map((pair) => pair.score);

  const wins = supported.reduce(
    (sum, s) => sum + unsupported.reduce((inner, u) => inner + (s > u ? 1 : s === u ? 0.5 : 0), 0),
    0,
  );
  const auc = supported.length * unsupported.length === 0 ? 1 : wins / (supported.length * unsupported.length);

  const scores = [...new Set(pairs.map((pair) => pair.score))].sort((a, b) => a - b);
  const candidates = scores.slice(1).map((score, index) => ({
    threshold: (score + scores[index]!) / 2,
    gap: score - scores[index]!,
  }));

  let best: Separation & { gap: number } = {
    threshold: (scores[0] ?? 0) - 1,
    accuracy: -1,
    falsePositives: 0,
    falseNegatives: 0,
    auc,
    gap: 0,
  };

  // Below every score (everything supported) is a candidate too.
  for (const { threshold, gap } of [{ threshold: (scores[0] ?? 0) - 1, gap: 0 }, ...candidates]) {
    const falsePositives = unsupported.filter((score) => score >= threshold).length;
    const falseNegatives = supported.filter((score) => score < threshold).length;
    const accuracy = pairs.length === 0 ? 1 : 1 - (falsePositives + falseNegatives) / pairs.length;

    if (accuracy > best.accuracy || (accuracy === best.accuracy && gap > best.gap)) {
      best = { threshold, accuracy, falsePositives, falseNegatives, auc, gap };
    }
  }

  const { gap: _gap, ...result } = best;
  return result;
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
