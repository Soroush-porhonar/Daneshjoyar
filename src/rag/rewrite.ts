import { chat } from "../llm/ollamaClient.js";
import { REWRITE_SYSTEM_PROMPT } from "../llm/prompts/rewrite.js";
import { logger } from "../logger.js";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Messages longer than this are assumed to be self-contained questions. */
const MAX_FOLLOW_UP_LENGTH = 60;
const MAX_REWRITE_LENGTH = 300;
const CONTEXT_MESSAGES = 4;

/** Short messages that come after an earlier exchange are likely follow-ups. */
export function needsRewrite(text: string, previous: HistoryMessage[]): boolean {
  return previous.length >= 2 && text.trim().length <= MAX_FOLLOW_UP_LENGTH;
}

/** Returns the model's rewrite if it looks sane, otherwise null. */
export function cleanRewrite(output: string): string | null {
  const cleaned = output
    .trim()
    .replace(/^["«»“”']+|["«»“”']+$/g, "")
    .trim();

  if (!cleaned || cleaned.includes("\n") || cleaned.length > MAX_REWRITE_LENGTH) {
    return null;
  }

  return cleaned;
}

/**
 * Turns a follow-up like "explain more" into a standalone question using the
 * recent conversation. Falls back to the original text on any problem.
 * `force`: the router already decided the message is a follow-up, so the
 * length rule is skipped (it is only the fallback when the router did not say).
 */
export async function rewriteQuestion(
  text: string,
  previous: HistoryMessage[],
  signal?: AbortSignal,
  force = false,
): Promise<string> {
  if (previous.length === 0 || (!force && !needsRewrite(text, previous))) return text;

  try {
    const transcript = previous
      .slice(-CONTEXT_MESSAGES)
      .map(
        (message) =>
          `${message.role === "user" ? "کاربر" : "دستیار"}: ${message.content.slice(0, 600)}`,
      )
      .join("\n");

    const output = await chat({
      think: false,
      options: { temperature: 0, num_predict: 120 },
      timeoutMs: 60_000,
      signal,
      messages: [
        { role: "system", content: REWRITE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `مکالمه قبلی:\n${transcript}\n\nآخرین پیام کاربر:\n${text}`,
        },
      ],
    });

    const rewritten = cleanRewrite(output);

    logger.debug("[RAG] Question rewrite:", { original: text, rewritten });

    return rewritten ?? text;
  } catch (error: unknown) {
    if (signal?.aborted) throw error;

    logger.warn("[RAG] Question rewrite failed, using original:", error);

    return text;
  }
}
