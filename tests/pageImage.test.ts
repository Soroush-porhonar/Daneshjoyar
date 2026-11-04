import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { flattenLighting, inkBounds, preparePageImages, rowInk, stripCuts, textSpan } from "../src/rag/pageImage.js";

/** A white grayscale image with black rectangles (left, top, width, height). */
function grayPage(width: number, height: number, inked: [number, number, number, number][]): Uint8Array {
  const gray = new Uint8Array(width * height).fill(255);
  for (const [left, top, w, h] of inked) {
    for (let y = top; y < top + h; y++) gray.fill(0, y * width + left, y * width + left + w);
  }
  return gray;
}

/** A PNG page with "text lines" (top, height) of word-like blocks across 80% of the width. */
async function pngPage(width: number, height: number, lines: [number, number][]): Promise<Uint8Array> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "black";
  for (const [top, h] of lines) {
    for (let x = width * 0.1; x < width * 0.9; x += 20) context.fillRect(x, top, 10, h);
  }
  return canvas.encode("png");
}

/** Lines of word-like marks: `lines` lines every 40 px from `top`, words 16 px wide with 8 px gaps. */
const textBlock = (left: number, top: number, right: number, lines: number): [number, number, number, number][] =>
  Array.from({ length: lines }).flatMap((_, line) =>
    Array.from({ length: Math.floor((right - left) / 24) }, (_, word): [number, number, number, number] => [
      left + word * 24,
      top + line * 40,
      16,
      12,
    ]),
  );

describe("flattenLighting", () => {
  /** Text on paper that darkens from 200 (left) to 90 (right), as in a phone photo lit from one side. */
  function unevenPhoto(width: number, height: number, text: [number, number, number, number][]): Uint8Array {
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) gray[y * width + x] = Math.round(200 - (110 * x) / width);
    }
    for (const [left, top, w, h] of text) {
      for (let y = top; y < top + h; y++) {
        for (let x = left; x < left + w; x++) gray[y * width + x] = Math.round(gray[y * width + x]! * 0.4);
      }
    }
    return gray;
  }

  it("makes paper white and keeps ink dark, however the page is lit", () => {
    const flat = flattenLighting(unevenPhoto(400, 600, textBlock(40, 100, 380, 5)), 400, 600);

    // Well above the ink level (160); a block takes its paper from its brightest neighbour.
    expect(flat[50 * 400 + 30]).toBeGreaterThan(210); // paper, bright side
    expect(flat[50 * 400 + 370]).toBeGreaterThan(210); // paper, dark side
    expect(flat[105 * 400 + 45]).toBeLessThan(110); // ink, bright side
    expect(flat[105 * 400 + 353]).toBeLessThan(110); // ink, dark side
  });

  it("changes nothing on white paper", () => {
    const gray = grayPage(400, 600, textBlock(60, 100, 350, 5));

    expect(flattenLighting(gray, 400, 600)).toEqual(gray);
  });

  it("a dim photo is cropped to all of its text, not to the brightest part", async () => {
    // Without flattening, most of this paper is darker than the ink level.
    const text = textBlock(40, 100, 380, 5);
    const gray = flattenLighting(unevenPhoto(400, 600, text), 400, 600);

    const box = inkBounds(gray, 400, 600);

    expect(box.left).toBeLessThanOrEqual(40);
    expect(box.left + box.width).toBeGreaterThanOrEqual(40 + 13 * 24 + 16);
    // Unflattened, the darker right half is all "ink": no text-like lines, so the box is wrong.
    expect(inkBounds(unevenPhoto(400, 600, text), 400, 600)).not.toEqual(box);
  });
});

describe("inkBounds", () => {
  // Five lines of text from (60, 100) to about (340, 272) on a 400 x 600 page.
  const text = textBlock(60, 100, 350, 5);
  const [textRight, textBottom] = [60 + 11 * 24 + 16, 100 + 4 * 40 + 12];

  it("finds the text box, with a small margin", () => {
    const box = inkBounds(grayPage(400, 600, text), 400, 600);

    expect(box.left).toBeLessThanOrEqual(60);
    expect(box.left).toBeGreaterThan(50);
    expect(box.top).toBeLessThanOrEqual(100);
    expect(box.top).toBeGreaterThan(90);
    expect(box.left + box.width).toBeGreaterThanOrEqual(textRight);
    expect(box.top + box.height).toBeGreaterThanOrEqual(textBottom);
    expect(box.top + box.height).toBeLessThan(textBottom + 10);
  });

  it("ignores a speck, a broken shadow along the edge and a logo in a corner", () => {
    const gray = grayPage(400, 600, [
      ...text,
      [20, 20, 1, 1], // a speck of dust
      // A dark shadow along the left edge, broken into pieces.
      [0, 0, 8, 140],
      [0, 150, 8, 200],
      [0, 360, 8, 240],
      // A scanner app's logo in the bottom-right corner: a small block of "letters".
      ...textBlock(300, 570, 396, 1).map(([x, y, w]): [number, number, number, number] => [x, y, w - 8, 8]),
    ]);

    const box = inkBounds(gray, 400, 600);

    expect(box.left).toBeGreaterThan(50);
    expect(box.top).toBeGreaterThan(90);
    expect(box.top + box.height).toBeLessThan(textBottom + 10);
    expect(box.left + box.width).toBeLessThan(textRight + 10);
  });

  it("keeps the full page when there is no text-like ink", () => {
    expect(inkBounds(new Uint8Array(100 * 100).fill(255), 100, 100)).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  });
});

describe("textSpan", () => {
  const lines = (on: [number, number][]) =>
    Array.from({ length: 100 }, (_, i) => on.some(([from, to]) => i >= from && i <= to));

  it("drops a small block that a wide gap separates from the text", () => {
    expect(textSpan(lines([[10, 60], [90, 91]]), 100)).toEqual([10, 60]);
    expect(textSpan(lines([[2, 3], [20, 70]]), 100)).toEqual([20, 70]);
  });

  it("keeps blocks close to the text, and large separate blocks", () => {
    expect(textSpan(lines([[10, 60], [64, 65]]), 100)).toEqual([10, 65]);
    expect(textSpan(lines([[10, 40], [70, 90]]), 100)).toEqual([10, 90]);
  });
});

describe("stripCuts", () => {
  it("does not cut what already fits", () => {
    expect(stripCuts(new Array(100).fill(5), 100)).toEqual([]);
  });

  it("cuts in the blank gap between lines, not through a line", () => {
    // Lines of ink with one blank row every 10 rows (rows 9, 19, 29, ...).
    const ink = Array.from({ length: 100 }, (_, row) => (row % 10 === 9 ? 0 : 50));

    const cuts = stripCuts(ink, 60);

    expect(cuts).toHaveLength(1);
    expect(ink[cuts[0]!]).toBe(0);
  });

  it("never makes a strip taller than allowed", () => {
    const ink = Array.from({ length: 1000 }, (_, row) => (row % 37 === 0 ? 0 : 20));

    const edges = [0, ...stripCuts(ink, 300), 1000];

    for (let i = 1; i < edges.length; i++) expect(edges[i]! - edges[i - 1]!).toBeLessThanOrEqual(300);
    expect(edges.length - 1).toBe(4);
  });
});

describe("rowInk", () => {
  it("counts dark pixels per row inside the box", () => {
    const gray = grayPage(10, 3, [[2, 1, 5, 1]]);
    expect(rowInk(gray, 10, { left: 0, top: 0, width: 10, height: 3 })).toEqual([0, 5, 0]);
    expect(rowInk(gray, 10, { left: 4, top: 1, width: 6, height: 1 })).toEqual([3]);
  });
});

describe("preparePageImages", () => {
  it("sends a page that fits as it is", async () => {
    const png = await pngPage(100, 140, [[20, 8]]);

    const images = await preparePageImages(png, { crop: false, tilePixels: 100 * 140 });

    expect(images).toHaveLength(1);
    expect(Buffer.compare(images[0]!, Buffer.from(png))).toBe(0);
  });

  it("cuts a tall page into strips within the pixel budget, between the lines", async () => {
    const lines: [number, number][] = Array.from({ length: 14 }, (_, i) => [20 + i * 40, 20]);
    const png = await pngPage(200, 600, lines);

    const images = await preparePageImages(png, { crop: false, tilePixels: 200 * 250 });
    const sizes = await Promise.all(images.map((image) => loadImage(image)));

    expect(images.length).toBe(3);
    expect(sizes.every((image) => image.width * image.height <= 200 * 250)).toBe(true);
    expect(sizes.reduce((sum, image) => sum + image.height, 0)).toBe(600);
    // Every strip begins in a gap: its first row has no ink.
    for (const image of sizes) {
      const canvas = createCanvas(image.width, 1);
      canvas.getContext("2d").drawImage(image, 0, 0);
      const row = canvas.getContext("2d").getImageData(0, 0, image.width, 1).data;
      expect(row.every((value) => value > 200)).toBe(true);
    }
  });

  it("crops the empty margins", async () => {
    const png = await pngPage(200, 300, [[100, 12], [130, 12], [160, 12], [190, 12]]);

    const [image] = await preparePageImages(png, { crop: true, tilePixels: 200 * 300 });
    const cropped = await loadImage(image!);

    expect(cropped.height).toBeLessThan(110);
    expect(cropped.width).toBeLessThan(180);
  });
});
