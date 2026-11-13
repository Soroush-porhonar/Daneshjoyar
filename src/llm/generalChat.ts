import type { ChatHistoryMessage } from "../db/messages.js";
import { config } from "../config.js";
import { markCut } from "./cut.js";
import { trimHistory } from "./history.js";
import { chat } from "./ollamaClient.js";
import { CHAT_SYSTEM_PROMPT } from "./prompts/chat.js";

/** Answers a general (non-document) question using the recent conversation. */
export async function askAI(
  history: ChatHistoryMessage[],
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<string> {
  let doneReason: string | undefined;
  const answer = await chat({
    // Thinking first made chat answers 2.2x slower (49 s vs 22 s, measured) with similar answers.
    think: false,
    messages: [{ role: "system", content: CHAT_SYSTEM_PROMPT }, ...trimHistory(history, config.rag.chatHistory)],
    options: { temperature: config.llm.temperature.chat, num_predict: config.llm.maxTokens.chat },
    signal,
    onDelta,
    onStats: (stats) => {
      doneReason = stats.doneReason;
    },
  });

  return markCut(answer, doneReason);
}
