import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { openImage } from "../src/rag/image.js";
import { PdfExtractError } from "../src/errors.js";

let dir: string;

/** A 200 x 100 image: black on the left quarter, white elsewhere. */
async function sample(format: "png" | "jpeg" | "webp"): Promise<Buffer> {
  const canvas = createCanvas(200, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 200, 100);
  context.fillStyle = "black";
  context.fillRect(0, 0, 50, 100);
  return format === "png" ? canvas.encode("png") : format === "jpeg" ? canvas.encode("jpeg") : canvas.encode("webp");
}

/** Inserts an EXIF block saying "rotate 90° clockwise to view" (orientation 6), as phones write. */
function withRotation(jpeg: Buffer): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const length = payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, length >> 8, length & 255]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

async function file(name: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "image-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openImage", () => {
  it.each(["png", "jpeg", "webp"] as const)("opens a %s as one page with no text, so OCR reads it", async (format) => {
    const image = await openImage(await file(`page.${format}`, await sample(format)));

    expect(image.pages).toEqual([{ pageNumber: 1, text: "", method: "text" }]);
  });

  it("renders the page at the requested width, in proportion", async () => {
    const image = await openImage(await file("wide.png", await sample("png")));

    const rendered = await loadImage(await image.renderPage(1, 1400));

    expect([rendered.width, rendered.height]).toEqual([1400, 700]);
  });

  it("turns a photo taken sideways upright (EXIF rotation)", async () => {
    const image = await openImage(await file("rotated.jpg", withRotation(await sample("jpeg"))));

    const rendered = await loadImage(await image.renderPage(1, 100));

    expect([rendered.width, rendered.height]).toEqual([100, 200]);
  });

  it("refuses a file that is not an image", async () => {
    await expect(openImage(await file("fake.jpg", Buffer.from("not an image")))).rejects.toBeInstanceOf(
      PdfExtractError,
    );
  });

  it("has no second page", async () => {
    const image = await openImage(await file("one.png", await sample("png")));

    await expect(image.renderPage(2, 100)).rejects.toBeInstanceOf(PdfExtractError);
  });
});
