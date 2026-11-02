/**
 * OCR quality evaluation with an automatic answer key: pages whose text layer
 * is good are rendered to images, read by the vision model, and compared with
 * the real text. Lets OCR settings (prompt, image width) be compared with numbers.
 * Slow on CPU (~40 s per page).
 *
 *   npm run eval:ocr -- uploads/x.pdf              # first 3 good pages
 *   npm run eval:ocr -- uploads/x.pdf --pages 2,5  # chosen pages
 *
 * Scanned PDFs have no text layer to compare with; give hand-written reference
 * text instead (<prefix>-p<page>.txt) and compare settings in one run. Each
 * page is read once per width and prompt; the repairs of reversed words
 * (none, page, word, both) are scored on the same output. Raw outputs are saved.
 *
 *   npm run eval:ocr -- uploads/x.pdf --pages 1,2,5 --ref eval/ocr-reference/camscanner \
 *     --widths 1000,1400,1800 --prompts en,fa
 *
 * Metrics (lower CER / higher recall is better):
 *   CER         - character error rate: edit distance / reference length
 *   word recall - share of the reference words that appear in the OCR text
 *                 (ignores reading order, which differs on slides with columns)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { cleanOcrText, ocrPage, readPageImage } from "../src/rag/ocr.js";
import { openPdf } from "../src/rag/pdf.js";
import { assessPage, normalizeText } from "../src/rag/textQuality.js";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--") && arg.endsWith(".pdf"));
const pagesIndex = args.indexOf("--pages");
const chosen = pagesIndex >= 0 ? args[pagesIndex + 1]!.split(",").map(Number) : null;

if (!file) {
  console.error("Usage: npm run eval:ocr -- <file.pdf> [--pages 2,5]");
  process.exit(1);
}

/** Levenshtein distance with two rows of memory. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length]!;
}

/** Same text, same score: Persian digits as ASCII, one space between words. */
const clean = (text: string) =>
  normalizeText(text)
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/\s+/g, " ")
    .trim();
const words = (text: string) => clean(text).split(" ").filter((w) => w.length > 1);

const cer = (read: string, reference: string) => editDistance(clean(read), clean(reference)) / Math.max(clean(reference).length, 1);
const recall = (read: string, reference: string) => {
  const found = new Set(words(read));
  const expected = words(reference);
  return expected.filter((w) => found.has(w)).length / Math.max(expected.length, 1);
};
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

const pdf = await openPdf(file);
const rows: Record<string, string | number>[] = [];
const refIndex = args.indexOf("--ref");

if (refIndex >= 0) {
  // --- Scanned pages against hand-written reference text ---------------------------
  const prefix = args[refIndex + 1]!;
  const list = (name: string, fallback: string) => {
    const index = args.indexOf(`--${name}`);
    return (index >= 0 ? args[index + 1]! : fallback).split(",");
  };
  const widths = list("widths", String(config.ocr.imageWidth)).map(Number);
  const prompts = list("prompts", config.ocr.prompt) as ("en" | "fa")[];
  const repairs = {
    none: (text: string) => normalizeText(text),
    page: (text: string, page: number) => cleanOcrText(text, page, "page"),
    word: (text: string, page: number) => cleanOcrText(text, page, "word"),
    both: (text: string, page: number) => cleanOcrText(text, page, "both"),
  };
  const raw: { page: number; width: number; prompt: string; seconds: number; text: string }[] = [];
  const totals = new Map<string, { errors: number; chars: number; recall: number; seconds: number; n: number }>();

  try {
    for (const page of chosen ?? [1]) {
      const reference = await readFile(`${prefix}-p${page}.txt`, "utf-8");

      for (const width of widths) {
        for (const prompt of prompts) {
          console.log(`... page ${page}, width ${width}, prompt ${prompt}`);
          const start = performance.now();
          const text = await readPageImage(pdf, page, { imageWidth: width, prompt });
          const seconds = (performance.now() - start) / 1000;
          raw.push({ page, width, prompt, seconds, text });

          for (const [repair, apply] of Object.entries(repairs)) {
            const read = apply(text, page);
            const variant = `w${width} ${prompt} ${repair}`;
            const total = totals.get(variant) ?? { errors: 0, chars: 0, recall: 0, seconds: 0, n: 0 };
            total.errors += editDistance(clean(read), clean(reference));
            total.chars += clean(reference).length;
            total.recall += recall(read, reference);
            total.seconds += seconds;
            total.n++;
            totals.set(variant, total);
            rows.push({ page, variant, CER: pct(cer(read, reference)), "word recall": pct(recall(read, reference)), s: Math.round(seconds) });
          }
        }
      }
    }
  } finally {
    await pdf.close();
  }

  console.table(rows);
  console.log("\nAll pages (CER weighted by reference length):");
  console.table(
    [...totals.entries()]
      .sort((a, b) => a[1].errors / a[1].chars - b[1].errors / b[1].chars)
      .map(([variant, t]) => ({
        variant,
        CER: pct(t.errors / t.chars),
        "word recall": pct(t.recall / t.n),
        "s/page": Math.round(t.seconds / t.n),
      })),
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await mkdir("eval/results", { recursive: true });
  await writeFile(`eval/results/ocr-${stamp}.json`, JSON.stringify({ file, raw }, null, 2));
  console.log(`Saved eval/results/ocr-${stamp}.json`);
  process.exit(0);
}

try {
  const candidates = pdf.pages.filter(
    (page) =>
      (chosen ? chosen.includes(page.pageNumber) : true) &&
      assessPage(page.text, config.ocr.minChars).ok,
  );
  const pages = chosen ? candidates : candidates.slice(0, 3);

  for (const page of pages) {
    console.log(`... page ${page.pageNumber}`);
    const start = performance.now();
    const ocr = await ocrPage(pdf, page.pageNumber);
    const seconds = (performance.now() - start) / 1000;

    const reference = clean(page.text);
    const read = clean(ocr);
    const ocrWords = new Set(words(read));
    const referenceWords = words(reference);

    rows.push({
      page: page.pageNumber,
      chars: reference.length,
      CER: `${((editDistance(read, reference) / Math.max(reference.length, 1)) * 100).toFixed(0)}%`,
      "word recall": `${(
        (referenceWords.filter((w) => ocrWords.has(w)).length / Math.max(referenceWords.length, 1)) *
        100
      ).toFixed(0)}%`,
      s: Math.round(seconds),
    });

    console.log(`reference: ${reference.slice(0, 160)}\nocr:       ${read.slice(0, 160)}\n`);
  }
} finally {
  await pdf.close();
}

console.table(rows);
console.log(`model=${config.llm.model} imageWidth=${config.ocr.imageWidth}`);
