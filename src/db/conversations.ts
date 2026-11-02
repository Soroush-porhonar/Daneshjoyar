import { pool } from "./pool.js";

export async function findOrCreateConversation(
  userId: number,
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `
      INSERT INTO conversations (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO UPDATE
      SET user_id = EXCLUDED.user_id
      RETURNING id
    `,
    [userId],
  );

  const conversation = result.rows[0];

  if (!conversation) {
    throw new Error("Failed to create or retrieve conversation");
  }

  return conversation.id;
}
