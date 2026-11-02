import { pool } from "../db/pool.js";
import { openPdf } from "./pdf.js";
import type { TextChunk } from "./chunk.js";
import { chunkDocument } from "./semanticChunk.js";
import { extractPages } from "./ocr.js";
import type { ExtractionProgress } from "./ocr.js";
import { generateEmbeddings } from "./embeddings.js";
import { DuplicateDocumentError, PdfExtractError } from "../errors.js";
import { logger } from "../logger.js";

const EMBED_BATCH_SIZE = 16;

export interface IngestResult {
  documentId: number;
  pageCount: number;
  /** Pages whose text came from the vision model instead of the PDF's text layer. */
  ocrPages: number;
}

/** PostgreSQL error code for a unique-index violation. */
const UNIQUE_VIOLATION = "23505";

export async function ingestPdf(
  userId: number,
  filename: string,
  filePath: string,
  onProgress?: (progress: ExtractionProgress) => Promise<void> | void,
  /**
   * Size of the uploaded file: with a size, the same user can't add the same
   * file (name and size) twice. Null for scripts that re-ingest on purpose.
   */
  fileSize: number | null = null,
): Promise<IngestResult> {
  let documentResult;

  try {
    documentResult = await pool.query<{ id: number }>(
      `
        INSERT INTO documents (user_id, filename, status, file_size)
        VALUES ($1, $2, 'processing', $3)
        RETURNING id
      `,
      [userId, filename, fileSize],
    );
  } catch (error: unknown) {
    // Two uploads of the same file at nearly the same time: the index catches it.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new DuplicateDocumentError(`Document already exists: ${filename}`);
    }
    throw error;
  }

  const document = documentResult.rows[0];

  if (!document) {
    throw new Error("Failed to create document record");
  }

  const documentId = document.id;

  try {
    const pdf = await openPdf(filePath);
    let extraction;

    try {
      extraction = await extractPages(pdf, onProgress);
    } finally {
      await pdf.close();
    }

    const chunks = await chunkDocument(extraction.pages);

    if (chunks.length === 0) {
      throw new PdfExtractError("The PDF contains no usable text");
    }

    // Generate embeddings before opening the transaction.
    const embeddedChunks: (TextChunk & { embedding: number[] })[] = [];

    for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
      const embeddings = await generateEmbeddings(
        batch.map((chunk) => chunk.embedText),
      );

      batch.forEach((chunk, index) => {
        embeddedChunks.push({ ...chunk, embedding: embeddings[index]! });
      });
    }

    // Save all chunks and mark the document completed atomically.
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const chunk of embeddedChunks) {
        const vector = `[${chunk.embedding.join(",")}]`;

        await client.query(
          `INSERT INTO document_chunks
     (document_id, chunk_index, page_number, page_end, content, embedding,
      extraction_method, section_title, section_index)
   VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9)`,
          [
            documentId,
            chunk.chunkIndex,
            chunk.pageNumber,
            chunk.pageEnd,
            chunk.content,
            vector,
            chunk.method,
            chunk.sectionTitle,
            chunk.sectionIndex,
          ],
        );
      }

      await client.query(
        `
    UPDATE documents
    SET status = 'completed'
    WHERE id = $1
  `,
        [documentId],
      );

      // Automatically select the newly uploaded document.
      await client.query(
        `
    UPDATE conversations
    SET selected_document_id = $2,
        updated_at = NOW()
    WHERE user_id = $1
  `,
        [userId, documentId],
      );

      await client.query("COMMIT");
    } catch (error: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError: unknown) {
        logger.error("Failed to roll back document ingestion:", {
          documentId,
          error: rollbackError,
        });
      }

      throw error;
    } finally {
      client.release();
    }

    logger.info(`Document ${documentId} ingested: ${chunks.length} chunks`);

    return {
      documentId,
      pageCount: extraction.pages.length,
      ocrPages: extraction.ocrPages,
    };
  } catch (error: unknown) {
    try {
      await pool.query(`UPDATE documents SET status = 'failed' WHERE id = $1`, [
        documentId,
      ]);
    } catch (statusError: unknown) {
      logger.error("Failed to update document status:", statusError);
    }

    throw error;
  }
}
