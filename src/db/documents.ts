import { pool } from "./pool.js";
import { PHOTO_FILENAME_PATTERN } from "../rag/documentKind.js";

export type DocumentStatus = "pending" | "processing" | "completed" | "failed";

export interface DocumentSummary {
  id: number;
  filename: string;
  status: DocumentStatus;
  /** From background enrichment; null until the document is enriched. */
  title?: string | null;
  topics?: string[] | null;
}

export async function listDocuments(userId: number): Promise<DocumentSummary[]> {
  const result = await pool.query<DocumentSummary>(
    `SELECT id, filename, status, title, topics
     FROM documents
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC`,
    [userId],
  );

  return result.rows;
}

/** An upload that was still being processed when the bot stopped. */
export interface InterruptedUpload {
  chatId: string;
  filename: string;
}

/**
 * Marks uploads left 'processing' by a crash or restart as failed and returns
 * them. Only one bot runs, so at startup nothing is really still processing;
 * their chunks were never saved (they are written in one transaction at the
 * end). Failed uploads don't count as duplicates, so the file can be sent again.
 */
export async function failInterruptedDocuments(): Promise<InterruptedUpload[]> {
  const result = await pool.query<InterruptedUpload>(
    `UPDATE documents d
     SET status = 'failed'
     FROM users u
     WHERE u.id = d.user_id
       AND d.status = 'processing'
     RETURNING u.bale_chat_id AS "chatId", d.filename`,
  );

  return result.rows;
}

/**
 * The user's existing copy of a file (same name and size), if any. Failed
 * uploads don't count, so a file can be sent again after a failure.
 */
export async function findDuplicateDocument(
  userId: number,
  filename: string,
  fileSize: number,
): Promise<{ id: number; status: DocumentStatus } | null> {
  const result = await pool.query<{ id: number; status: DocumentStatus }>(
    `SELECT id, status
     FROM documents
     WHERE user_id = $1 AND filename = $2 AND file_size = $3 AND status <> 'failed'
     ORDER BY id DESC
     LIMIT 1`,
    [userId, filename, fileSize],
  );

  return result.rows[0] ?? null;
}

export async function findDocumentFilename(
  userId: number,
  documentId: number,
): Promise<string | null> {
  const result = await pool.query<{ filename: string }>(
    `SELECT filename
     FROM documents
     WHERE id = $1 AND user_id = $2`,
    [documentId, userId],
  );

  return result.rows[0]?.filename ?? null;
}

export interface CompletedDocument {
  id: number;
  filename: string;
  /** From background enrichment; null until the document is enriched. */
  title?: string | null;
  topics?: string[] | null;
}

/** The user's ready documents, newest first. */
export async function listCompletedDocuments(userId: number): Promise<CompletedDocument[]> {
  const result = await pool.query<CompletedDocument>(
    `SELECT id, filename, title, topics
     FROM documents
     WHERE user_id = $1
       AND status = 'completed'
     ORDER BY created_at DESC, id DESC`,
    [userId],
  );

  return result.rows;
}

export interface DocumentProfile {
  title: string | null;
  summary: string | null;
  topics: string[] | null;
}

/** A document's enrichment profile (all null until enriched); null if it is not the user's. */
export async function getDocumentProfile(userId: number, documentId: number): Promise<DocumentProfile | null> {
  const result = await pool.query<DocumentProfile>(
    `SELECT title, summary, topics FROM documents WHERE id = $1 AND user_id = $2`,
    [documentId, userId],
  );

  return result.rows[0] ?? null;
}

/**
 * Names of the user's ready documents, for the router. A photo's name says
 * nothing about it ("capture_6791184992758507927.jpg", measured: a question on
 * one was routed to chat), so once enriched it comes with its generated title.
 */
export async function listCompletedFilenames(userId: number): Promise<string[]> {
  const result = await pool.query<{ filename: string }>(
    `SELECT DISTINCT
       CASE WHEN filename ~* $2 AND title IS NOT NULL
            THEN filename || ' (' || title || ')'
            ELSE filename
       END AS filename
     FROM documents
     WHERE user_id = $1
       AND status = 'completed'`,
    [userId, PHOTO_FILENAME_PATTERN],
  );

  return result.rows.map((row) => row.filename);
}

export async function deleteDocument(
  userId: number,
  documentId: number,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM documents
     WHERE id = $1
       AND user_id = $2
     RETURNING id`,
    [documentId, userId],
  );

  return result.rowCount === 1;
}
