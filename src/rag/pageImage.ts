import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";

/** A pixel darker than this (0 = black, 255 = white) counts as ink. */
const INK_LEVEL = 160;
/** A row or column with less ink than this share of the page holds only specks... */
const MIN_INK_SHARE = 0.003;
/** ...and one dark almost from edge to edge is a scan border or shadow (text has gaps). */
const MAX_INK_SHARE = 0.9;
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

/** Ink pixels in each column of `box`. */
function columnInk(gray: Uint8Array, imageWidth: number, box: Box): number[] {
  const ink = new Array<number>(box.width).fill(0);

  for (let y = 0; y < box.height; y++) {
    const start = (box.top + y) * imageWidth + box.left;
    for (let x = 0; x < box.width; x++) if (gray[start + x]! < INK_LEVEL) ink[x]!++;
  }

  return ink;
}

/** A row or column needs at least this many ink pixels to count, whatever its length. */
const MIN_INK_PIXELS = 3;

/** First and last index whose ink share is text-like (not specks, not a border); null if none. */
function textSpan(ink: number[], length: number): [first: number, last: number] | null {
  const isText = (count: number) =>
    count >= Math.max(MIN_INK_PIXELS, length * MIN_INK_SHARE) && count / length <= MAX_INK_SHARE;
  const first = ink.findIndex(isText);
  if (first < 0) return null;
  return [first, ink.findLastIndex(isText)];
}

/**
 * The box around the text of a page, with a small margin. Specks of dust and
 * the dark borders or shadows of phone scans are ignored; a page with no
 * text-like ink keeps its full size. Columns are counted over the text rows
 * only (and rows again over the text columns), so a dark band along one
 * edge does not stretch the box in the other direction.
 */
export function inkBounds(gray: Uint8Array, width: number, height: number): Box {
  let box: Box = { left: 0, top: 0, width, height };

  for (let pass = 0; pass < 2; pass++) {
    // Shares of the whole page: a border spans it, a bold heading does not.
    const rows = textSpan(rowInk(gray, width, box), width);
    if (!rows) return { left: 0, top: 0, width, height };
    box = { ...box, top: box.top + rows[0], height: rows[1] - rows[0] + 1 };

    const columns = textSpan(columnInk(gray, width, box), height);
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
