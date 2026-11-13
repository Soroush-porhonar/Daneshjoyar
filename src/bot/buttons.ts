/**
 * Inline buttons and their callback data. Formats (all within Bale's 64 bytes):
 *   fb:<log id>:<1|-1>   👍/👎 on an answer
 *   info:<document id>   show a document's full name and status
 *   del:<document id>    ask to delete a document
 *   delok / delno        confirm / cancel the pending delete
 *   docs                 show the documents list
 *   cancel               stop the running request
 *   cf:<token>:<y|n>     yes / no to a question something waits on (confirmations.ts);
 *                        ocr:<token>:<y|n> on messages sent before it was generalised
 */
import type { InlineButton } from "../bale.js";
import type { DocumentSummary } from "../db/documents.js";
import {
  CANCEL_BUTTON,
  OCR_CANCEL_BUTTON,
  OCR_CONTINUE_BUTTON,
  DELETE_BUTTON,
  DELETE_CANCEL_BUTTON,
  DELETE_CONFIRM_BUTTON,
  MENU_DOCUMENTS,
  documentDisplayName,
  documentNameButton,
} from "../messages.js";

export type Callback =
  | { action: "info" | "delete"; documentId: number }
  | { action: "confirmDelete" | "cancelDelete" | "documents" | "cancel" }
  | { action: "confirm"; token: string; yes: boolean };

/** Longest document name shown on its (full-width) button. */
const MAX_NAME_LENGTH = 40;

function shortName(filename: string): string {
  const name = filename.replace(/\.pdf$/i, "");
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name;
}

/**
 * Two rows per document: the name alone (buttons in a row share the width
 * equally, so it gets the full width), then [🗑️ حذف]. Tapping the name shows
 * its full name and status.
 */
export function documentButtons(documents: DocumentSummary[]): InlineButton[][] {
  return documents.flatMap((document) => [
    [
      {
        text: documentNameButton(shortName(documentDisplayName(document.filename, document.title)), document.status),
        callback_data: `info:${document.id}`,
      },
    ],
    [{ text: DELETE_BUTTON, callback_data: `del:${document.id}` }],
  ]);
}

export const confirmDeleteButtons = (): InlineButton[][] => [
  [
    { text: DELETE_CONFIRM_BUTTON, callback_data: "delok" },
    { text: DELETE_CANCEL_BUTTON, callback_data: "delno" },
  ],
];

export const confirmButtons = (
  token: string,
  yes: string = OCR_CONTINUE_BUTTON,
  no: string = OCR_CANCEL_BUTTON,
): InlineButton[][] => [
  [
    { text: yes, callback_data: `cf:${token}:y` },
    { text: no, callback_data: `cf:${token}:n` },
  ],
];

export const cancelButton = (): InlineButton[][] => [[{ text: CANCEL_BUTTON, callback_data: "cancel" }]];

export const documentsButton = (): InlineButton[][] => [[{ text: MENU_DOCUMENTS, callback_data: "docs" }]];

const SIMPLE: Record<string, Callback> = {
  delok: { action: "confirmDelete" },
  delno: { action: "cancelDelete" },
  docs: { action: "documents" },
  cancel: { action: "cancel" },
};

/** Parses document and menu callback data; feedback ("fb:") is parsed in feedback.ts. */
export function parseCallback(data: string | undefined): Callback | null {
  if (!data) return null;
  if (Object.hasOwn(SIMPLE, data)) return SIMPLE[data]!;

  const confirm = /^(?:cf|ocr):([0-9a-f]{8}):([yn])$/.exec(data);
  if (confirm) return { action: "confirm", token: confirm[1]!, yes: confirm[2] === "y" };

  // Old list messages may still carry "sel:" buttons; selection no longer exists.
  const match = /^(info|del):(\d+)$/.exec(data);
  if (!match) return null;

  const action = match[1] === "info" ? "info" : "delete";
  return { action, documentId: Number(match[2]) };
}
