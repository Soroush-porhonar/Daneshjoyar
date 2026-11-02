import { config } from "../config.js";
import type { ExtractionMethod, PageText } from "./pdf.js";
import {
  findBoilerplate,
  layoutOf,
  pageTitle,
  sectionIndexes,
  stripBoilerplate,
} from "./structure.js";
import type { Layout } from "./structure.js";
import { hasReversedLines, normalizeText, reverseLineWords } from "./textQuality.js";

export interface TextChunk {
  chunkIndex: number;
  /** Page where the chunk starts. */
  pageNumber: number;
  /** Page where it ends (differs only when running text crosses a page). */
  pageEnd: number;
  /** The cleaned text stored and shown to the model. */
  content: string;
  /** The text that is embedded: content, plus the slide title when the chunk lacks it. */
  embedText: string;
  method: ExtractionMethod;
  /** Slide decks only: the slide title and the group of slides sharing it. */
  sectionTitle: string | null;
  sectionIndex: number | null;
}

export interface ChunkOptions {
  chunkSize: number;
  overlap: number;
  stripBoilerplate: boolean;
  titleInEmbedding: boolean;
  crossPage: boolean;
  semantic: boolean;
}

const DEFAULT_OPTIONS: ChunkOptions = {
  chunkSize: config.rag.chunkSize,
  overlap: config.rag.chunkOverlap,
  ...config.rag.chunking,
};

/** Sentence/paragraph terminators, strongest first. */
const BOUNDARIES = ["\n\n", "\n", "۔", "؟", "؛", "!", ". "];

function findBoundary(window: string): number {
  for (const boundary of BOUNDARIES) {
    const index = window.lastIndexOf(boundary);

    if (index >= 0) return index;
  }

  return -1;
}

/**
 * Splits text into [start, end) ranges of at most chunkSize characters,
 * preferring paragraph and sentence boundaries; ranges overlap a little.
 */
export function splitRanges(text: string, chunkSize: number, overlap: number): [number, number][] {
  if (text.length <= chunkSize) return [[0, text.length]];

  const ranges: [number, number][] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      const searchStart = start + Math.floor(chunkSize * 0.7);
      const boundary = findBoundary(text.slice(searchStart, end));

      if (boundary >= 0) {
        end = searchStart + boundary + 1;
      }
    }

    if (text.slice(start, end).trim()) ranges.push([start, end]);

    if (end >= text.length) break;

    start = end - overlap;
  }

  return ranges;
}

export interface CleanPage {
  pageNumber: number;
  text: string;
  method: ExtractionMethod;
}

/** Normalizes the pages and removes what is noise for search (reversed lines, headers, page numbers). */
export function cleanPages(pages: PageText[], options: ChunkOptions): CleanPage[] {
  let texts = pages.map((page) => normalizeText(page.text));

  if (hasReversedLines(texts)) {
    texts = texts.map(reverseLineWords);
  }

  if (options.stripBoilerplate) {
    const boilerplate = findBoilerplate(texts);
    texts = texts.map((text, i) => stripBoilerplate(text, pages[i]!.pageNumber, boilerplate));
  }

  return pages
    .map((page, i) => ({ pageNumber: page.pageNumber, text: texts[i]!, method: page.method }))
    .filter((page) => page.text.length > 0);
}

/** The chunk text plus its slide title when the text does not start with it. */
export function withTitle(title: string | null | undefined, content: string): string {
  return title && !content.startsWith(title) ? `${title}
${content}` : content;
}

/** Slide decks: chunks stay inside their slide and carry its title and section. */
function chunkPaged(pages: CleanPage[], options: ChunkOptions): Omit<TextChunk, "chunkIndex">[] {
  const titles = pages.map((page) => pageTitle(page.text));
  const sections = sectionIndexes(titles);

  return pages.flatMap((page, i) => {
    const title = titles[i]!;

    return splitRanges(page.text, options.chunkSize, options.overlap).map(([start, end]) => {
      const content = page.text.slice(start, end).trim();

      return {
        pageNumber: page.pageNumber,
        pageEnd: page.pageNumber,
        content,
        embedText: options.titleInEmbedding ? withTitle(title, content) : content,
        method: page.method,
        sectionTitle: title,
        sectionIndex: sections[i]!,
      };
    });
  });
}

/**
 * Running text: the pages are joined so a paragraph continuing on the next
 * page stays in one chunk. Each chunk records the pages it spans.
 */
function chunkFlowing(pages: CleanPage[], options: ChunkOptions): Omit<TextChunk, "chunkIndex">[] {
  if (!options.crossPage) {
    return pages.flatMap((page) => chunkFlowing([page], { ...options, crossPage: true }));
  }

  // Where each page starts in the joined text.
  const starts: number[] = [];
  let text = "";

  for (const page of pages) {
    if (text) text += "\n";
    starts.push(text.length);
    text += page.text;
  }

  const pageAt = (offset: number) => {
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1]! <= offset) index++;
    return index;
  };

  return splitRanges(text, options.chunkSize, options.overlap).map(([start, end]) => {
    const raw = text.slice(start, end);
    // Measure from the first/last real character so whitespace doesn't change the page.
    const first = pageAt(start + (raw.length - raw.trimStart().length));
    const last = pageAt(end - 1 - (raw.length - raw.trimEnd().length));
    const covered = pages.slice(first, last + 1);
    const content = raw.trim();

    return {
      pageNumber: pages[first]!.pageNumber,
      pageEnd: pages[last]!.pageNumber,
      content,
      embedText: content,
      method: covered.some((page) => page.method === "ocr") ? "ocr" : "text",
      sectionTitle: null,
      sectionIndex: null,
    };
  });
}

export function chunkOptions(overrides: Partial<ChunkOptions> = {}): ChunkOptions {
  const options = { ...DEFAULT_OPTIONS, ...overrides };

  if (options.chunkSize <= 0 || options.overlap < 0 || options.overlap >= options.chunkSize) {
    throw new Error("Invalid chunkSize or overlap");
  }

  return options;
}

/** Cleans the pages and decides whether they are a slide deck or running text. */
export function prepareDocument(
  pages: PageText[],
  options: ChunkOptions,
): { clean: CleanPage[]; layout: Layout } {
  const clean = cleanPages(pages, options);
  return { clean, layout: layoutOf(clean.map((page) => page.text)) };
}

/** Cleans the pages and splits them into chunks suited to the document's layout. */
export function chunkPages(
  pages: PageText[],
  overrides: Partial<ChunkOptions> = {},
): TextChunk[] {
  const options = chunkOptions(overrides);
  const { clean, layout } = prepareDocument(pages, options);

  if (clean.length === 0) return [];

  const chunks = layout === "paged" ? chunkPaged(clean, options) : chunkFlowing(clean, options);

  return chunks.map((chunk, chunkIndex) => ({ ...chunk, chunkIndex }));
}
