import { config } from "../config.js";
import { chat } from "../llm/ollamaClient.js";
import { OCR_PROMPT, OCR_PROMPT_FA, OCR_STRIP_PROMPT, OCR_STRIP_PROMPT_FA } from "../llm/prompts/ocr.js";
import { logger } from "../logger.js";
import { preparePageImages, type PageImageSettings } from "./pageImage.js";
import type { PageText, PdfHandle } from "./pdf.js";
import {
  assessPage,
  hasReversedWords,
  isDegenerateOcr,
  mostlyReversed,
  normalizeText,
  repairReversedWords,
  reverseWordLetters,
} from "./textQuality.js";

export interface ExtractionProgress {
  /** Pages that will be read with the vision model. */
  ocrTotal: number;
  ocrDone: number;
  /** Poor pages left on their text layer because of the page cap. */
  skipped: number;
}

export interface ExtractionResult {
  pages: PageText[];
  ocrPages: number;
}

export interface OcrSettings extends PageImageSettings {
  renderWidth: number;
  prompt: "en" | "fa";
  repair: "page" | "word" | "both";
}

const defaultSettings = (): OcrSettings => ({
  renderWidth: config.ocr.renderWidth,
  tilePixels: config.ocr.tilePixels,
  crop: config.ocr.crop,
  prompt: config.ocr.prompt,
  repair: config.ocr.repair,
});

/** A page's raw transcription and how many images (strips) it was read in. */
export interface PageRead {
  text: string;
  strips: number;
}

/**
 * The vision model's raw transcription of one page (eval:ocr compares
 * settings with it): rendered, optionally cropped, and read strip by strip
 * when it is too big for one image.
 */
export async function readPageImage(
  pdf: PdfHandle,
  pageNumber: number,
  settings: Omit<OcrSettings, "repair"> = defaultSettings(),
  signal?: AbortSignal,
): Promise<PageRead> {
  const images = await preparePageImages(await pdf.renderPage(pageNumber, settings.renderWidth), settings);
  const strips = images.length > 1;
  const prompt =
    settings.prompt === "fa"
      ? strips ? OCR_STRIP_PROMPT_FA : OCR_PROMPT_FA
      : strips ? OCR_STRIP_PROMPT : OCR_PROMPT;
  const parts: string[] = [];

  // One at a time: there is one GPU.
  for (const image of images) {
    parts.push(
      await chat({
        think: false,
        options: { temperature: 0, num_predict: 2048 },
        timeoutMs: config.ocr.timeoutMs,
        signal,
        messages: [{ role: "user", content: prompt, images: [image.toString("base64")] }],
      }),
    );
  }

  return { text: parts.join("\n"), strips: images.length };
}

/** Normalises a transcription and repairs reversed words; "" if the output is unusable. */
export function cleanOcrText(
  text: string,
  pageNumber: number,
  repair: OcrSettings["repair"] = config.ocr.repair,
): string {
  if (isDegenerateOcr(text)) {
    logger.warn(`[OCR] Page ${pageNumber}: unusable output, keeping text layer`);
    return "";
  }

  const normalized = normalizeText(text);

  if (repair === "word") return repairReversedWords(normalized);

  if (repair === "both") {
    // Flip the page only if it is mostly reversed (judged on all known
    // words), then fix the words the model reversed one by one.
    const flip = mostlyReversed(normalized);
    if (flip) logger.info(`[OCR] Page ${pageNumber}: Persian words came out reversed, fixing`);
    return repairReversedWords(flip ? reverseWordLetters(normalized) : normalized);
  }

  if (hasReversedWords(normalized)) {
    logger.info(`[OCR] Page ${pageNumber}: Persian words came out reversed, fixing`);
    return reverseWordLetters(normalized);
  }

  return normalized;
}

/** Reads one page image with the vision model; returns "" if the output is unusable. */
export async function ocrPage(
  pdf: PdfHandle,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<string> {
  const settings = defaultSettings();
  const { text } = await readPageImage(pdf, pageNumber, settings, signal);
  return cleanOcrText(text, pageNumber, settings.repair);
}

/**
 * Returns the text of every page: the PDF's own text layer where it is good,
 * and vision-model OCR for pages that are empty or have broken letters.
 */
export async function extractPages(
  pdf: PdfHandle,
  onProgress?: (progress: ExtractionProgress) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const poor = config.ocr.enabled
    ? pdf.pages.filter(
        (page) => !assessPage(page.text, config.ocr.minChars).ok,
      )
    : [];

  const toOcr = poor.slice(0, config.ocr.maxPages);
  const progress: ExtractionProgress = {
    ocrTotal: toOcr.length,
    ocrDone: 0,
    skipped: poor.length - toOcr.length,
  };

  if (toOcr.length === 0) {
    return { pages: pdf.pages, ocrPages: 0 };
  }

  logger.info(
    `[OCR] ${toOcr.length} of ${pdf.pages.length} pages need OCR` +
      (progress.skipped > 0 ? ` (${progress.skipped} skipped by page cap)` : ""),
  );
  await onProgress?.({ ...progress });

  // Every 5 pages for small jobs, about every 10% for big ones.
  const reportEvery = Math.max(config.ocr.progressEvery, Math.ceil(toOcr.length / 10));
  const ocrByPage = new Map<number, string>();

  for (const page of toOcr) {
    const started = Date.now();
    const text = await ocrPage(pdf, page.pageNumber, signal);

    progress.ocrDone++;
    logger.info(
      `[OCR] Page ${page.pageNumber} done in ${Math.round((Date.now() - started) / 1000)}s ` +
        `(${progress.ocrDone}/${progress.ocrTotal})`,
    );

    if (text) ocrByPage.set(page.pageNumber, text);

    if (progress.ocrDone % reportEvery === 0) {
      await onProgress?.({ ...progress });
    }
  }

  const pages = pdf.pages.map((page) => {
    const text = ocrByPage.get(page.pageNumber);

    return text === undefined
      ? page
      : { pageNumber: page.pageNumber, text, method: "ocr" as const };
  });

  return { pages, ocrPages: ocrByPage.size };
}
