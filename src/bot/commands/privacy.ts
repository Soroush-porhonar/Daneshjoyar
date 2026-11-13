import { askConfirmation } from "../../chat/confirmations.js";
import { deleteUserData } from "../../db/documents.js";
import { removeUploadedFile } from "../../files.js";
import { logger } from "../../logger.js";
import {
  DELETE_MY_DATA_NO_BUTTON,
  DELETE_MY_DATA_QUESTION,
  DELETE_MY_DATA_YES_BUTTON,
  MY_DATA_DELETED_TEXT,
  MY_DATA_KEPT_TEXT,
} from "../../messages.js";
import type { CommandHandler } from "./types.js";

/** Asked for this long; no answer keeps the data. */
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/**
 * /deletemydata (roadmap 8.10): after a yes, everything stored about the
 * student is deleted (rows and uploaded files). The reply is not saved,
 * since the conversation it would go into is gone.
 */
export const deleteMyDataCommand: CommandHandler = async ({ chatId, userId }) => {
  const yes = await askConfirmation(chatId, DELETE_MY_DATA_QUESTION, {
    yes: DELETE_MY_DATA_YES_BUTTON,
    no: DELETE_MY_DATA_NO_BUTTON,
    timeoutMs: CONFIRM_TIMEOUT_MS,
  });
  if (!yes) return MY_DATA_KEPT_TEXT;

  const files = await deleteUserData(userId, chatId);
  await Promise.all(files.map(removeUploadedFile));
  logger.info("User data deleted:", { userId, files: files.length });
  return { text: MY_DATA_DELETED_TEXT, forgotUser: true };
};
