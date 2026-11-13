import { SOURCES_HEADING } from "../messages.js";

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The conversation as the router and general chat read it: the last
 * `messages` turns, an answer's source list dropped (file names and pages say
 * nothing about the conversation), and each turn cut to its first `chars`
 * characters. Whole answers (a summary runs to 6000 characters) otherwise
 * filled the prompt before the model reached the new message.
 */
export function trimHistory<T extends HistoryMessage>(
  history: T[],
  { messages, chars }: { messages: number; chars: number },
): T[] {
  return history.slice(-messages).map((message) => {
    const body = message.role === "assistant" ? message.content.split(SOURCES_HEADING)[0]!.trim() : message.content;
    return { ...message, content: body.length > chars ? `${body.slice(0, chars).trimEnd()}…` : body };
  });
}
