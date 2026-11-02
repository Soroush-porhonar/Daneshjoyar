import { pool } from "./pool.js";

export type Feedback = 1 | -1;

/** A chunk the model saw, as stored in the log. */
export interface LoggedChunk {
  /** Missing in rows logged before answers could use several documents. */
  documentId?: number;
  page: number | null;
  pageEnd?: number | null;
  chunkIndex: number;
  isHit: boolean;
}

export interface NewAnswerLog {
  userId: number;
  question: string;
  rewrittenQuestion: string | null;
  route: "document" | "chat";
  retrievalMode: string | null;
  /** The documents the answer drew on. */
  documentIds: number[];
  context: LoggedChunk[];
  answer: string;
  latencyMs: number;
}

export async function createAnswerLog(log: NewAnswerLog): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO answer_logs
       (user_id, question, rewritten_question, route, retrieval_mode, document_ids,
        context, answer, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     RETURNING id`,
    [
      log.userId,
      log.question,
      log.rewrittenQuestion,
      log.route,
      log.retrievalMode,
      log.documentIds,
      JSON.stringify(log.context),
      log.answer,
      log.latencyMs,
    ],
  );

  return result.rows[0]!.id;
}

/** The search hits behind the user's latest answer, when it came from documents. */
export async function getLastAnswerHits(
  userId: number,
): Promise<{ documentId: number; chunkIndex: number }[]> {
  const result = await pool.query<{
    route: string;
    document_id: number | null;
    context: LoggedChunk[];
  }>(
    `SELECT route, document_id, context
     FROM answer_logs
     WHERE user_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [userId],
  );

  const row = result.rows[0];

  if (!row || row.route !== "document") return [];

  // Older rows name the document once for the whole answer.
  return row.context.flatMap((chunk) => {
    const documentId = chunk.documentId ?? row.document_id;
    return chunk.isHit && documentId != null ? [{ documentId, chunkIndex: chunk.chunkIndex }] : [];
  });
}

/**
 * Stores a 👍/👎 for an answer. Only the user who received the answer can rate
 * it; returns false for anyone else or an unknown answer.
 */
export async function setFeedback(
  logId: number,
  userId: number,
  feedback: Feedback,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE answer_logs
     SET feedback = $3, feedback_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [logId, userId, feedback],
  );

  return result.rowCount === 1;
}
