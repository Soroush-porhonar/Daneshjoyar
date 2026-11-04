import { readFile } from "node:fs/promises";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { PdfExtractError } from "../errors.js";
import type { PdfHandle } from "./pdf.js";

/** Larger images are refused before any drawing (a 12 MP phone photo is far below). */
const MAX_PIXELS = 60_000_000;

/** Draws `image` at `width` pixels wide (height in proportion) and returns PNG bytes. */
export async function scaleToWidth(image: Image, width: number): Promise<Buffer> {
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas.encode("png");
}

/**
 * A photo of a page (JPEG, PNG or WebP) as a one-page document with no text
 * layer, so OCR reads it like a scanned page: rendered at the OCR width,
 * cropped and cut into strips (src/rag/pageImage.ts). Phone photos taken
 * sideways come out upright: the decoder applies their EXIF rotation.
 *
 * Smaller photos are scaled up to the OCR width too. Measured on the 5
 * scanned reference pages turned into compressed JPEG photos (as messengers
 * send them): 1280 px long side read at its own 905 px width had 6.7%
 * character errors (23 s/page), scaled up to 1400 px 3.1% (39 s/page);
 * 1600 and 2560 px photos gave 3.2% and 3.3%, so compression down to
 * 1280 px costs nothing.
 */
export async function openImage(filePath: string): Promise<PdfHandle> {
  let image: Image;

  try {
    image = await loadImage(await readFile(filePath));
  } catch (error: unknown) {
    throw new PdfExtractError(
      `Failed to decode image: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (image.width === 0 || image.height === 0 || image.width * image.height > MAX_PIXELS) {
    throw new PdfExtractError(`Unusable image size: ${image.width}x${image.height}`);
  }

  return {
    pages: [{ pageNumber: 1, text: "", method: "text" }],
    async renderPage(pageNumber, width) {
      if (pageNumber !== 1) {
        throw new PdfExtractError(`An image has one page, not ${pageNumber}`);
      }
      return scaleToWidth(image, width);
    },
    close: async () => {},
  };
}
