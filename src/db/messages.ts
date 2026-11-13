import { config } from "../config.js";
import { pool } from "./pool.js";

export type MessageRole = "user" | "assistant" | "system";

export async function saveMessage(
  conversationId: number,
  role: MessageRole,
  content: string,
): Promise<void> {
  await pool.query(
    `
      WITH inserted AS (
        INSERT INTO messages (conversation_id, role, content)
        VALUES ($1, $2, $3)
        RETURNING conversation_id
      )
      UPDATE conversations
      SET updated_at = NOW()
      WHERE id = (SELECT conversation_id FROM inserted)
    `,
    [conversationId, role, content],
  );
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The latest messages of a conversation, oldest first: at most `limit`, none
 * older than `maxAgeMinutes`, and none from before the student started a new
 * topic (conversations.history_start).
 */
export async function getRecentMessages(
  conversationId: number,
  limit = 10,
  maxAgeMinutes: number = config.rag.historyMaxAgeMinutes,
): Promise<ChatHistoryMessage[]> {
  const result = await pool.query<ChatHistoryMessage>(
    `
      SELECT role, content
      FROM (
        SELECT m.id, m.role, m.content
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1
          AND m.role IN ('user', 'assistant')
          AND m.created_at >= NOW() - make_interval(mins => $3)
          AND m.created_at >= COALESCE(c.history_start, '-infinity'::timestamptz)
        ORDER BY m.id DESC
        LIMIT $2
      ) AS recent
      ORDER BY id ASC
    `,
    [conversationId, limit, maxAgeMinutes],
  );

  return result.rows;
}
