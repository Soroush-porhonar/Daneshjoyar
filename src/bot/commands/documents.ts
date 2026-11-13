import { removeUploadedFile } from "../../files.js";
import {
  deleteDocument,
  findDocumentFilename,
  listDocuments,
} from "../../db/documents.js";
import {
  DELETE_CANCELLED_TEXT,
  DELETE_FAILED_TEXT,
  DELETE_NOT_FOUND_TEXT,
  DELETE_USAGE_TEXT,
  NO_DOCUMENTS_TEXT,
  NO_PENDING_DELETE_TEXT,
  NO_PENDING_DELETE_TO_CANCEL_TEXT,
  deleteConfirmationText,
  deleteSucceededText,
  DOCUMENTS_LIST_TEXT,
} from "../../messages.js";
import {
  clearPendingDeletion,
  getPendingDeletion,
  setPendingDeletion,
} from "../pendingDelete.js";
import type { CommandHandler } from "./types.js";
import { confirmDeleteButtons, documentButtons } from "../buttons.js";

/** Parses a single positive-integer argument, or returns null. */
function parseDocumentId(args: string[]): number | null {
  const documentId = Number(args[0]);

  if (args.length !== 1 || !Number.isSafeInteger(documentId) || documentId <= 0) {
    return null;
  }

  return documentId;
}

export const documentsCommand: CommandHandler = async ({ userId }) => {
  const documents = await listDocuments(userId);

  if (documents.length === 0) {
    return NO_DOCUMENTS_TEXT;
  }

  return {
    text: DOCUMENTS_LIST_TEXT,
    markup: { inline: documentButtons(documents) },
  };
};

export const deleteCommand: CommandHandler = async ({
  chatId,
  userId,
  args,
}) => {
  const documentId = parseDocumentId(args);

  if (documentId === null) {
    return DELETE_USAGE_TEXT;
  }

  const filename = await findDocumentFilename(userId, documentId);

  if (filename === null) {
    return DELETE_NOT_FOUND_TEXT;
  }

  setPendingDeletion(chatId, documentId);

  return {
    text: deleteConfirmationText(filename, documentId),
    markup: { inline: confirmDeleteButtons() },
  };
};

export const confirmDeleteCommand: CommandHandler = async ({
  chatId,
  userId,
}) => {
  const documentId = getPendingDeletion(chatId);

  if (documentId === null) {
    return NO_PENDING_DELETE_TEXT;
  }

  const deleted = await deleteDocument(userId, documentId);
  clearPendingDeletion(chatId);
  if (!deleted) return DELETE_FAILED_TEXT;

  // The uploaded file goes too (roadmap 8.10).
  await removeUploadedFile(deleted.filePath);
  return deleteSucceededText(documentId);
};

export const cancelDeleteCommand: CommandHandler = async ({ chatId }) => {
  if (getPendingDeletion(chatId) === null) {
    return NO_PENDING_DELETE_TO_CANCEL_TEXT;
  }

  clearPendingDeletion(chatId);

  return DELETE_CANCELLED_TEXT;
};
