/**
 * How long student data is kept (roadmap 8.10; periods chosen by the owner):
 * the inbox for a week, the words of questions and answers in answer_logs
 * for 90 days (times, route, feedback, page references and stage timings
 * stay for the reports), and the last 200 messages of each conversation.
 */
import { config } from "../config.js";
import { pool } from "./pool.js";

export interface RetentionResult {
  updates: number;
  answerTexts: number;
  messages: number;
}

export async function applyRetention(): Promise<RetentionResult> {
  const { updatesDays, answerTextDays, messagesPerConversation } = config.retention;

  const updates = await pool.query(
    `DELETE FROM processed_updates WHERE processed_at < now() - make_interval(days => $1)`,
    [updatesDays],
  );
  const answerTexts = await pool.query(
    `UPDATE answer_logs
     SET question = '', rewritten_question = NULL, answer = ''
     WHERE created_at < now() - make_interval(days => $1)
       AND (question <> '' OR answer <> '' OR rewritten_question IS NOT NULL)`,
    [answerTextDays],
  );
  const messages = await pool.query(
    `DELETE FROM messages m
     USING (
       SELECT id, row_number() OVER (PARTITION BY conversation_id ORDER BY id DESC) AS newest
       FROM messages
     ) ranked
     WHERE m.id = ranked.id AND ranked.newest > $1`,
    [messagesPerConversation],
  );

  return {
    updates: updates.rowCount ?? 0,
    answerTexts: answerTexts.rowCount ?? 0,
    messages: messages.rowCount ?? 0,
  };
}
