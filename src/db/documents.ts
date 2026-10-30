import { pool } from "./pool.js";

export type DocumentStatus = "pending" | "processing" | "completed" | "failed";

export interface DocumentSummary {
  id: number;
  filename: string;
  status: DocumentStatus;
}

export async function listDocuments(userId: number): Promise<DocumentSummary[]> {
  const result = await pool.query<DocumentSummary>(
    `SELECT id, filename, status
     FROM documents
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC`,
    [userId],
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

export async function listCompletedFilenames(userId: number): Promise<string[]> {
  const result = await pool.query<{ filename: string }>(
    `SELECT DISTINCT filename
     FROM documents
     WHERE user_id = $1
       AND status = 'completed'`,
    [userId],
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
