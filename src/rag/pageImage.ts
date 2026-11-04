import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";

/** A pixel darker than this (0 = black, 255 = white) counts as ink. */
const INK_LEVEL = 160;
/** Shorter dark stretches are scan noise, not ink. */
const MIN_RUN = 2;
/** A row or column is text when it crosses at least this many separate dark runs... */
const MIN_RUNS = 3;
/** ...and, for a column, at most this share of it is dark. */
const MAX_COLUMN_INK = 0.5;
/** Text farther than this share of the page from the rest is a separate block... */
const SEPARATE_GAP = 0.06;
/** ...and a separate block at an edge smaller than this share is not part of the text. */
const SMALL_BLOCK = 0.04;
/** Margin kept around the text, as a share of the text box. */
const PADDING = 0.02;
/** Strips are cut within this share of a strip's height around the ideal cut. */
const CUT_WINDOW = 0.15;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageImageSettings {
  /** Crop the empty margins before reading. */
  crop: boolean;
  /** Most pixels in one image sent to the vision model; taller text is split into strips. */
  tilePixels: number;
}

/** Grayscale values (0–255), one per pixel, row by row. */
export function grayscale(rgba: Uint8ClampedArray): Uint8Array {
  const gray = new Uint8Array(rgba.length / 4);

  for (let i = 0; i < gray.length; i++) {
    gray[i] = (rgba[i * 4]! * 299 + rgba[i * 4 + 1]! * 587 + rgba[i * 4 + 2]! * 114) / 1000;
  }

  return gray;
}

/** Ink pixels in each row of `box`. */
export function rowInk(gray: Uint8Array, imageWidth: number, box: Box): number[] {
  return Array.from({ length: box.height }, (_, y) => {
    let ink = 0;
    const start = (box.top + y) * imageWidth + box.left;
    for (let x = 0; x < box.width; x++) if (gray[start + x]! < INK_LEVEL) ink++;
    return ink;
  });
}

/**
 * Whether one line of pixels (`step` 1 = a row, imageWidth = a column) looks
 * like text: it crosses several separate dark runs of at least MIN_RUN
 * pixels, and at most `maxInk` of it is dark.
 */
function isTextLine(gray: Uint8Array, start: number, step: number, length: number, maxInk: number): boolean {
  let runs = 0;
  let run = 0;
  let ink = 0;

  for (let i = 0; i < length; i++) {
    if (gray[start + i * step]! < INK_LEVEL) {
      ink++;
      if (++run === MIN_RUN) runs++;
    } else {
      run = 0;
    }
  }

  return runs >= MIN_RUNS && ink <= length * maxInk;
}

/**
 * For each row, or each column, of `box`: does it look like text? Only
 * columns may not be mostly dark (a shadow along the edge broken into
 * pieces): a row along a line of Persian text is dense where letters join.
 */
function textLines(gray: Uint8Array, imageWidth: number, box: Box, along: "rows" | "columns"): boolean[] {
  return along === "rows"
    ? Array.from({ length: box.height }, (_, y) =>
        isTextLine(gray, (box.top + y) * imageWidth + box.left, 1, box.width, 1),
      )
    : Array.from({ length: box.width }, (_, x) =>
        isTextLine(gray, box.top * imageWidth + box.left + x, imageWidth, box.height, MAX_COLUMN_INK),
      );
}

/**
 * First and last text line, leaving out small blocks at either end that a
 * wide gap separates from the rest (a scanner app's logo in a corner, a mark
 * in the margin); null if there is no text.
 */
export function textSpan(lines: boolean[], pageLength: number): [first: number, last: number] | null {
  const blocks: [number, number][] = [];

  lines.forEach((isText, i) => {
    if (!isText) return;
    const last = blocks.at(-1);
    if (last && i - last[1] <= pageLength * SEPARATE_GAP) last[1] = i;
    else blocks.push([i, i]);
  });

  const small = ([first, last]: [number, number]) => last - first + 1 < pageLength * SMALL_BLOCK;
  while (blocks.length > 1 && small(blocks.at(-1)!)) blocks.pop();
  while (blocks.length > 1 && small(blocks[0]!)) blocks.shift();

  return blocks.length > 0 ? [blocks[0]![0], blocks.at(-1)![1]] : null;
}

/**
 * The box around the text of a page, with a small margin. A row or column
 * belongs to the text when it crosses several separate dark runs (letters,
 * or lines of text): a speck of dust, the gray edge of the paper or a scan
 * shadow is one long or mostly dark run, and a logo in a corner is a small
 * separate block (textSpan). A page with no text-like ink keeps its full size. Columns are counted over the
 * text rows only (and rows again over the text columns), so a dark band
 * along one edge does not stretch the box in the other direction.
 */
export function inkBounds(gray: Uint8Array, width: number, height: number): Box {
  let box: Box = { left: 0, top: 0, width, height };

  for (let pass = 0; pass < 2; pass++) {
    const rows = textSpan(textLines(gray, width, box, "rows"), height);
    if (!rows) return { left: 0, top: 0, width, height };
    box = { ...box, top: box.top + rows[0], height: rows[1] - rows[0] + 1 };

    const columns = textSpan(textLines(gray, width, box, "columns"), width);
    if (!columns) return { left: 0, top: 0, width, height };
    box = { ...box, left: box.left + columns[0], width: columns[1] - columns[0] + 1 };
  }

  const padX = Math.round(box.width * PADDING);
  const padY = Math.round(box.height * PADDING);
  const left = Math.max(0, box.left - padX);
  const top = Math.max(0, box.top - padY);

  return {
    left,
    top,
    width: Math.min(width, box.left + box.width + padX) - left,
    height: Math.min(height, box.top + box.height + padY) - top,
  };
}

/**
 * Where to cut `ink.length` rows into strips of at most `maxRows` each: near
 * equal strips, each cut moved to the row with the least ink nearby (the gap
 * between two text lines), so no line is cut in half.
 */
export function stripCuts(ink: number[], maxRows: number): number[] {
  const cuts: number[] = [];
  let start = 0;

  while (ink.length - start > maxRows) {
    const target = (ink.length - start) / Math.ceil((ink.length - start) / maxRows);
    const ideal = Math.round(start + target);
    const reach = Math.round(target * CUT_WINDOW);
    const from = Math.max(start + 1, ideal - reach);
    const to = Math.min(start + maxRows, ideal + reach);

    let best = from;
    for (let row = from; row <= to; row++) {
      const fewer = ink[row]! < ink[best]!;
      const closer = ink[row] === ink[best] && Math.abs(row - ideal) < Math.abs(best - ideal);
      if (fewer || closer) best = row;
    }

    cuts.push(best);
    start = best;
  }

  return cuts;
}

async function encodeRegion(image: Image, box: Box): Promise<Buffer> {
  const canvas = createCanvas(box.width, box.height);
  canvas.getContext("2d").drawImage(image, box.left, box.top, box.width, box.height, 0, 0, box.width, box.height);
  return canvas.encode("png");
}

/**
 * The images to send the vision model for one rendered page, in reading
 * order: optionally cropped to its text, then cut into horizontal strips
 * small enough for the vision encoder. A page that already fits is sent as it is.
 */
export async function preparePageImages(png: Uint8Array, settings: PageImageSettings): Promise<Buffer[]> {
  const image = await loadImage(Buffer.from(png));
  const { width, height } = image;

  if (!settings.crop && width * height <= settings.tilePixels) return [Buffer.from(png)];

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const gray = grayscale(context.getImageData(0, 0, width, height).data);

  const box = settings.crop ? inkBounds(gray, width, height) : { left: 0, top: 0, width, height };
  const maxRows = Math.max(1, Math.floor(settings.tilePixels / box.width));
  const cuts = stripCuts(rowInk(gray, width, box), maxRows);
  const edges = [0, ...cuts, box.height];

  return Promise.all(
    edges.slice(1).map((end, i) =>
      encodeRegion(image, { left: box.left, top: box.top + edges[i]!, width: box.width, height: end - edges[i]! }),
    ),
  );
}
