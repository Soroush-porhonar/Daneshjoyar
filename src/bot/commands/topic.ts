import { findOrCreateConversation, startNewTopic } from "../../db/conversations.js";
import { NEW_TOPIC_TEXT } from "../../messages.js";
import type { CommandHandler } from "./types.js";

/** /new and the "🆕 موضوع جدید" button: later questions are not read as follow-ups of earlier ones. */
export const newTopicCommand: CommandHandler = async ({ userId }) => {
  await startNewTopic(await findOrCreateConversation(userId));
  return NEW_TOPIC_TEXT;
};
