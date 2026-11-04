import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { inkBounds, preparePageImages, rowInk, stripCuts } from "../src/rag/pageImage.js";

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

describe("inkBounds", () => {
  it("finds the text box, with a small margin", () => {
    const gray = grayPage(200, 300, [[40, 50, 120, 10], [40, 200, 120, 10]]);

    const box = inkBounds(gray, 200, 300);

    expect(box.left).toBeLessThanOrEqual(40);
    expect(box.left).toBeGreaterThan(30);
    expect(box.top).toBeLessThanOrEqual(50);
    expect(box.top).toBeGreaterThan(40);
    expect(box.left + box.width).toBeGreaterThanOrEqual(160);
    expect(box.top + box.height).toBeGreaterThanOrEqual(210);
    expect(box.top + box.height).toBeLessThan(220);
  });

  it("ignores specks of dust and a dark scan border", () => {
    const gray = grayPage(200, 300, [
      [40, 100, 120, 10], // text
      [5, 5, 1, 1], // a speck
      [0, 0, 200, 4], // a dark band along the top edge
    ]);

    const box = inkBounds(gray, 200, 300);

    expect(box.top).toBeGreaterThan(90);
    expect(box.left).toBeGreaterThan(30);
  });

  it("keeps the full page when there is no text-like ink", () => {
    expect(inkBounds(new Uint8Array(100 * 100).fill(255), 100, 100)).toEqual({ left: 0, top: 0, width: 100, height: 100 });
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
    const png = await pngPage(200, 300, [[100, 20], [140, 20]]);

    const [image] = await preparePageImages(png, { crop: true, tilePixels: 200 * 300 });
    const cropped = await loadImage(image!);

    expect(cropped.height).toBeLessThan(80);
    expect(cropped.width).toBeLessThan(180);
  });
});
