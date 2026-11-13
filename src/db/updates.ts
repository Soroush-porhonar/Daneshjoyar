/**
 * The inbox of Bale updates (roadmap 8.9). An update is stored as "received"
 * before its work starts and marked "done" or "failed" when the work ends;
 * the sweeper (src/bot/sweeper.ts) retries the unfinished ones.
 */
import type { BaleUpdate } from "../bale.js";
import { pool } from "./pool.js";

export type UpdateStatus = "received" | "done" | "failed" | "abandoned";

export interface InboxUpdate {
  updateId: number;
  status: UpdateStatus;
  attempts: number;
  payload: BaleUpdate;
  /** When Bale first delivered it. */
  receivedAt: Date;
}

/**
 * Stores a new update as "received". Returns false if it was seen before
 * (Bale delivers again until the offset moves): its retries belong to the sweeper.
 */
export async function receiveUpdate(update: BaleUpdate): Promise<boolean> {
  const result = await pool.query(
    `
      INSERT INTO processed_updates (update_id, status, payload)
      VALUES ($1, 'received', $2)
      ON CONFLICT (update_id) DO NOTHING
    `,
    [update.update_id, JSON.stringify(update)],
  );

  return result.rowCount === 1;
}

/** Marks the update's work as finished: "done", or "failed" for the sweeper to retry. */
export async function finishUpdate(updateId: number, ok: boolean): Promise<void> {
  await pool.query(
    `UPDATE processed_updates SET status = $2, updated_at = now() WHERE update_id = $1`,
    [updateId, ok ? "done" : "failed"],
  );
}

/** Gives up on an update (too many attempts or too old to answer now). */
export async function abandonUpdate(updateId: number): Promise<void> {
  await pool.query(
    `UPDATE processed_updates SET status = 'abandoned', updated_at = now() WHERE update_id = $1`,
    [updateId],
  );
}

/**
 * Updates to retry: "failed" ones, and "received" ones untouched for
 * `staleMs` (their work was cut off by a restart), except those running now.
 */
export async function listUnfinishedUpdates(staleMs: number, running: number[]): Promise<InboxUpdate[]> {
  const result = await pool.query<{
    update_id: string;
    status: UpdateStatus;
    attempts: number;
    payload: BaleUpdate | null;
    processed_at: Date;
  }>(
    `
      SELECT update_id, status, attempts, payload, processed_at
      FROM processed_updates
      WHERE payload IS NOT NULL
        AND (status = 'failed'
             OR (status = 'received' AND updated_at < now() - make_interval(secs => $1 / 1000.0)))
        AND NOT (update_id = ANY($2::bigint[]))
      ORDER BY update_id
    `,
    [staleMs, running],
  );

  return result.rows.map((row) => ({
    updateId: Number(row.update_id),
    status: row.status,
    attempts: row.attempts,
    payload: row.payload!,
    receivedAt: row.processed_at,
  }));
}

/** True if the chat sent a text message after this update (a retry would cancel its answer). */
export async function hasLaterMessage(chatId: number, updateId: number): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1 FROM processed_updates
        WHERE update_id > $2
          AND payload -> 'message' -> 'chat' ->> 'id' = $1
          AND payload -> 'message' ? 'text'
      ) AS exists
    `,
    [String(chatId), updateId],
  );

  return result.rows[0]?.exists ?? false;
}

/**
 * Claims an update for another attempt: back to "received" with one more
 * attempt. Returns false if something else changed it meanwhile.
 */
export async function claimRetry(updateId: number, status: UpdateStatus): Promise<boolean> {
  const result = await pool.query(
    `
      UPDATE processed_updates
      SET status = 'received', attempts = attempts + 1, updated_at = now()
      WHERE update_id = $1 AND status = $2
    `,
    [updateId, status],
  );

  return result.rowCount === 1;
}
