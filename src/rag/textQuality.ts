import { readFileSync } from "node:fs";

/** Invisible characters that carry no meaning (ZWNJ U+200C is kept: it matters in Persian). */
const INVISIBLE = /[​‍‎‏‪-‮⁠﻿]/g;

/** Tabs, no-break and other unusual spaces. */
const ODD_SPACES = /[\t   -   　]/g;

/**
 * Cleans text extracted from a PDF so embeddings and prompts see normal Persian:
 * - NFKC turns Arabic presentation forms (ﺑﺨﺶ) into regular letters (بخش)
 * - Arabic yeh/kaf become Persian ی/ک
 * - tabs and odd spaces become single spaces
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(ODD_SPACES, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\r\n?/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n +/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type PageAssessment = { ok: true } | { ok: false; reason: string };

/** A single Arabic-script letter standing alone (و is a real one-letter word, so it is ignored). */
const ISOLATED_LETTER = /^[\u0621-\u063A\u0641-\u064A\u067E\u0686\u0698\u06A9\u06AF\u06CC]$/;

/**
 * Share of isolated letters above which Persian text is considered broken (م ی کرد).
 * Measured: pages with 12–43% isolated letters (testing notes, the COVID PDF)
 * were searched and answered just as well from the text layer as after OCR
 * (21 eval questions), while OCR cost ~45 s/page and sometimes garbled text.
 * So only text worse than anything measured goes to OCR.
 */
const BROKEN_LETTER_RATIO = 0.5;
const MIN_TOKENS_FOR_RATIO = 15;

/**
 * Below this share of letters the text layer is junk (fonts mapped to digits
 * and symbols). Measured: junk PDFs 0%, code-heavy real slides at least 40%.
 */
const MIN_LETTER_RATIO = 0.2;

/**
 * Decides whether a page's text layer is trustworthy.
 * Poor pages (empty, junk symbols, or letters split by spaces) are candidates for OCR.
 */
export function assessPage(text: string, minChars: number): PageAssessment {
  const normalized = normalizeText(text);
  const visible = normalized.replace(/\s/g, "");

  if (visible.length < minChars) {
    return { ok: false, reason: "no text layer" };
  }

  const letters = visible.match(/\p{L}/gu)?.length ?? 0;

  if (letters / visible.length < MIN_LETTER_RATIO) {
    return { ok: false, reason: "junk text" };
  }

  const tokens = normalized.split(/\s+/);

  if (tokens.length >= MIN_TOKENS_FOR_RATIO) {
    const isolated = tokens.filter(
      (token) => token !== "و" && ISOLATED_LETTER.test(token),
    ).length;

    if (isolated / tokens.length > BROKEN_LETTER_RATIO) {
      return { ok: false, reason: "broken letters" };
    }
  }

  return { ok: true };
}

/** Sentence punctuation that ends a Persian sentence or clause. */
const LINE_PUNCTUATION = /^[.!?؟،؛:]/;
const LINE_END_PUNCTUATION = /[.!?؟،؛:]$/;

/**
 * Some PDFs store each line of Persian text with its words in reverse order
 * (".آمدم دنیا به" instead of "به دنیا آمدم."). The tell-tale sign is that
 * punctuation sits at the start of lines instead of the end.
 */
export function hasReversedLines(pages: string[]): boolean {
  const lines = pages
    .flatMap((page) => page.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.split(/\s+/).length >= 3);

  if (lines.length < 10) return false;

  const starts = lines.filter((line) => LINE_PUNCTUATION.test(line)).length;
  const ends = lines.filter((line) => LINE_END_PUNCTUATION.test(line)).length;

  // Measured: the reversed PDF has 19% of lines starting with punctuation
  // (and few ending with it); normal documents have at most 1%.
  return starts / lines.length >= 0.1 && starts > 2 * ends;
}

/** Puts the words of every line back in reading order; leading punctuation moves to the end. */
export function reverseLineWords(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .trim()
        .split(/\s+/)
        .reverse()
        .map((word) => word.replace(/^([.!?؟،؛:]+)(.+)$/, "$2$1"))
        .join(" "),
    )
    .join("\n");
}

/** Very common Persian words; their reversed spellings are almost never real words. */
const COMMON_WORDS = ["از", "در", "که", "را", "این", "است", "برای", "های", "به", "با", "می", "یک"];
const REVERSED_WORDS = new Set(COMMON_WORDS.map((word) => [...word].reverse().join("")));
const NORMAL_WORDS = new Set(COMMON_WORDS);

/** A run of Persian/Arabic letters (not digits or punctuation); ZWNJ stays inside words. */
const PERSIAN_LETTERS = /[ء-يٱ-ۓە‌]+/g;

/** One Persian word, for counting words (see scripts/build-word-frequencies.ts). */
export const PERSIAN_WORD = PERSIAN_LETTERS;

/**
 * The vision model sometimes writes every Persian word with its letters in
 * reverse ("تراهم یاه" for "مهارت های") while English stays correct. True when
 * reversed spellings of common words clearly outnumber the normal ones.
 */
export function hasReversedWords(text: string): boolean {
  let normal = 0;
  let reversed = 0;

  for (const token of text.split(/[\s.,:;!?؟،؛()«»"]+/)) {
    if (NORMAL_WORDS.has(token)) normal++;
    else if (REVERSED_WORDS.has(token)) reversed++;
  }

  return reversed >= 3 && reversed > 2 * normal;
}

/** Reverses the letters inside every Persian word; English, digits and punctuation are untouched. */
export function reverseWordLetters(text: string): string {
  return text.replace(PERSIAN_LETTERS, (word) => [...word].reverse().join(""));
}

/** A reversed spelling must occur at least this often in good text to be trusted... */
const REPAIR_MIN_COUNT = 3;
/** ...and this many times more often than the word as written (5 would turn درک into کرد: 61 vs 7). */
const REPAIR_RATIO = 10;

let wordCounts: Map<string, number> | null = null;

/** Word counts from good text layers (src/rag/wordFrequencies.json, npm run build:words). */
function loadWordCounts(): Map<string, number> {
  wordCounts ??= new Map(
    Object.entries(
      JSON.parse(readFileSync(new URL("./wordFrequencies.json", import.meta.url), "utf-8")) as Record<
        string,
        number
      >,
    ),
  );
  return wordCounts;
}

/**
 * Word by word: flips a Persian word whose reversed spelling is a much more
 * common word («هب» -> «به», «رد» -> «در»), and leaves every other word as it
 * is. Unlike reverseWordLetters, correct words on the same page stay correct
 * when the vision model reversed only some of them.
 */
export function repairReversedWords(
  text: string,
  counts: ReadonlyMap<string, number> = loadWordCounts(),
): string {
  return text.replace(PERSIAN_LETTERS, (word) => {
    if ([...word].length < 2) return word;

    const reversed = [...word].reverse().join("");
    const asWritten = counts.get(word) ?? 0;
    const flipped = counts.get(reversed) ?? 0;

    return flipped >= REPAIR_MIN_COUNT && flipped > REPAIR_RATIO * asWritten ? reversed : word;
  });
}

/**
 * True when far more of a text's words are known words once flipped than as
 * written: the model reversed (nearly) the whole page. Judged on all known
 * words, not a few common ones, so a page with only some reversed words is
 * left to the word-by-word repair.
 */
export function mostlyReversed(
  text: string,
  counts: ReadonlyMap<string, number> = loadWordCounts(),
): boolean {
  let asWritten = 0;
  let flipped = 0;

  for (const word of text.match(PERSIAN_LETTERS) ?? []) {
    if ([...word].length < 2) continue;
    if (counts.has(word)) asWritten++;
    if (counts.has([...word].reverse().join(""))) flipped++;
  }

  return flipped > 2 * asWritten;
}

/** True for model output that is empty or stuck in a loop (same line repeated). */
export function isDegenerateOcr(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return true;

  const counts = new Map<string, number>();

  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  return Math.max(...counts.values()) > 8 && lines.length > 12;
}
