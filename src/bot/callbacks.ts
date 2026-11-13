import {
  answerCallbackQuery,
  editMessageText,
  removeButtons,
  sendMessage,
} from "../bale.js";
import type { BaleUpdate } from "../bale.js";
import { findOrCreateUser } from "../db/users.js";
import { logger } from "../logger.js";
import { listDocuments } from "../db/documents.js";
import {
  CONFIRMATION_EXPIRED_TEXT,
  DELETE_NOT_FOUND_TEXT,
  NO_REQUEST_TO_CANCEL_TEXT,
  REQUEST_CANCELLED_TEXT,
  documentInfoText,
} from "../messages.js";
import { parseCallback } from "./buttons.js";
import { answerConfirmation } from "../chat/confirmations.js";
import { cancelRequest } from "./cancellation.js";
import {
  cancelDeleteCommand,
  confirmDeleteCommand,
  deleteCommand,
  documentsCommand,
} from "./commands/documents.js";
import type { CommandReply } from "./commands/types.js";
import { handleFeedback } from "./feedback.js";

type CallbackQuery = NonNullable<BaleUpdate["callback_query"]>;

const textOf = (reply: string | CommandReply) => (typeof reply === "string" ? reply : reply.text);

async function send(chatId: number, reply: string | CommandReply): Promise<void> {
  await (typeof reply === "string"
    ? sendMessage(chatId, reply)
    : sendMessage(chatId, reply.text, reply.markup));
}

/** Changing an old message is a nicety; never fail the press because of it. */
async function tryTo(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    logger.warn("Could not update the message with buttons:", error);
  }
}

/**
 * Handles a button press. Buttons run the same logic as the typed commands
 * (so ownership checks are the same), and the press is always acknowledged,
 * otherwise Bale keeps the button "loading".
 */
export async function handleCallback(query: CallbackQuery): Promise<void> {
  if (query.data?.startsWith("fb:")) {
    await handleFeedback(query);
    return;
  }

  const callback = parseCallback(query.data);
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;

  if (!callback || chatId === undefined) {
    await answerCallbackQuery(query.id);
    return;
  }

  if (callback.action === "confirm") {
    // The work waiting on this question goes on or stops; the buttons go either way.
    const delivered = answerConfirmation(callback.token, chatId, callback.yes);
    await answerCallbackQuery(query.id, delivered ? undefined : CONFIRMATION_EXPIRED_TEXT);
    if (messageId !== undefined) await tryTo(() => removeButtons(chatId, messageId));
    return;
  }

  if (callback.action === "cancel") {
    const cancelled = cancelRequest(chatId);
    await answerCallbackQuery(query.id, cancelled ? REQUEST_CANCELLED_TEXT : NO_REQUEST_TO_CANCEL_TEXT);
    if (messageId !== undefined) await tryTo(() => removeButtons(chatId, messageId));
    return;
  }

  const user = await findOrCreateUser(String(chatId));
  const context = { chatId, userId: user.id, args: [] as string[] };

  switch (callback.action) {
    case "info": {
      // Only the user's own documents: the list is fetched for this user.
      const document = (await listDocuments(user.id)).find((d) => d.id === callback.documentId);
      await answerCallbackQuery(
        query.id,
        document
          ? documentInfoText(document.filename, document.status, document.title, document.topics)
          : DELETE_NOT_FOUND_TEXT,
      );
      return;
    }

    case "documents": {
      await answerCallbackQuery(query.id);
      await send(chatId, await documentsCommand(context));
      return;
    }

    case "delete": {
      await answerCallbackQuery(query.id);
      await send(chatId, await deleteCommand({ ...context, args: [String(callback.documentId)] }));
      return;
    }

    case "confirmDelete":
    case "cancelDelete": {
      const handler = callback.action === "confirmDelete" ? confirmDeleteCommand : cancelDeleteCommand;
      const result = textOf(await handler(context));
      await answerCallbackQuery(query.id);

      // Replace the question with the result, so the buttons can't be pressed twice.
      if (messageId !== undefined) {
        await tryTo(() => editMessageText(chatId, messageId, result));
      } else {
        await sendMessage(chatId, result);
      }
      return;
    }
  }
}
