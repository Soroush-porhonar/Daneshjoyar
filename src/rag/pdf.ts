import { PDFParse } from "pdf-parse";
import { PdfExtractError } from "../errors.js";

export type ExtractionMethod = "text" | "ocr";

export interface PageText {
  pageNumber: number;
  text: string;
  method: ExtractionMethod;
}

/**
 * An opened PDF: its text layer plus the ability to render pages to images.
 * A photo is opened as a one-page handle with no text layer (src/rag/image.ts).
 */
export interface PdfHandle {
  pages: PageText[];
  /** Renders a page (1-based) to PNG bytes. */
  renderPage(pageNumber: number, width: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export async function openPdf(filePath: string): Promise<PdfHandle> {
  const parser = new PDFParse({ url: filePath });

  try {
    const result = await parser.getText();

    return {
      pages: result.pages.map((page) => ({
        pageNumber: page.num,
        text: page.text,
        method: "text" as const,
      })),
      async renderPage(pageNumber, width) {
        const screenshot = await parser.getScreenshot({
          partial: [pageNumber],
          desiredWidth: width,
        });
        const page = screenshot.pages[0];

        if (!page) {
          throw new PdfExtractError(`Could not render page ${pageNumber}`);
        }

        return page.data;
      },
      close: () => parser.destroy(),
    };
  } catch (error: unknown) {
    await parser.destroy().catch(() => {});

    throw new PdfExtractError(
      `Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
