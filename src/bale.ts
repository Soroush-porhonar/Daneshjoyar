import { config } from "./config.js";
import { logger } from "./logger.js";
import path from "node:path";
import { mkdir, open, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const BASE_URL = `https://tapi.bale.ai/bot${config.baleToken}`;
const FILE_BASE_URL = `https://tapi.bale.ai/file/bot${config.baleToken}`;

const MAX_FILE_SIZE = config.bale.maxFileSize;
const MAX_MESSAGE_LENGTH = config.bale.maxMessageLength;

export function splitMessage(text: string): string[] {
  const parts: string[] = [];
  let remaining = text.trim();

  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);

    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }

    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = MAX_MESSAGE_LENGTH;
    }

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}
export interface BaleDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** One size of a photo; Bale sends several, from a thumbnail up to the largest it keeps. */
export interface BalePhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface BaleUpdate {
  update_id: number;
  message?: {
    chat: {
      id: number;
    };
    text?: string;
    document?: BaleDocument;
    photo?: BalePhotoSize[];
    /** Content the bot does not read; only checked for presence, to say so. */
    sticker?: unknown;
    voice?: unknown;
    audio?: unknown;
    video?: unknown;
    video_note?: unknown;
    animation?: unknown;
    contact?: unknown;
    location?: unknown;
  };
  /** A press on an inline keyboard button. */
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number };
    };
  };
}

export interface InlineButton {
  text: string;
  /** 1–64 bytes, sent back in the callback query. */
  callback_data: string;
}

/**
 * What can be attached to a message: buttons under it (`inline`), or a
 * keyboard at the bottom of the chat whose labels are sent as text (`keyboard`).
 */
export type Markup = { inline: InlineButton[][] } | { keyboard: string[][] };

function replyMarkup(markup: Markup): Record<string, unknown> {
  return "inline" in markup
    ? { inline_keyboard: markup.inline }
    : { keyboard: markup.keyboard.map((row) => row.map((text) => ({ text }))) };
}

interface SentMessage {
  message_id: number;
}

interface BaleFile {
  file_id: string;
  file_path: string;
  file_size?: number;
}

interface BaleResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

async function callBale<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${BASE_URL}/${method}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(config.bale.apiTimeoutMs),
  });

  let data: BaleResponse<T>;

  try {
    data = (await response.json()) as BaleResponse<T>;
  } catch {
    throw new Error(
      `Bale API returned an invalid response: HTTP ${response.status}`,
    );
  }

  if (!response.ok || data.ok !== true) {
    throw new Error(
      data.description ?? `Bale API error: HTTP ${response.status}`,
    );
  }

  return data.result;
}

/**
 * Sends a message, split into parts if it is too long. Buttons or a keyboard,
 * if any, are attached to the last part, whose message id is returned.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  markup?: Markup,
): Promise<number | undefined> {
  const parts = splitMessage(text);
  let lastId: number | undefined;

  for (const [index, part] of parts.entries()) {
    logger.debug(
      `[Bale] Sending part ${index + 1}/${parts.length}, length: ${part.length}`,
    );

    const isLast = index === parts.length - 1;

    const sent = await callBale<SentMessage | undefined>("sendMessage", {
      chat_id: chatId,
      text: part,
      ...(isLast && markup ? { reply_markup: replyMarkup(markup) } : {}),
    });
    lastId = sent?.message_id;
  }

  return lastId;
}

/** Replaces the text (and buttons) of a sent message; no buttons removes them. */
export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  buttons?: InlineButton[][],
): Promise<void> {
  await callBale("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: buttons ?? [] },
  });
}

/** Acknowledges a button press; Bale keeps the button "loading" until this is called. */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await callBale("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/** Removes the inline buttons from a sent message. */
export async function removeButtons(chatId: number, messageId: number): Promise<void> {
  await callBale("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

export async function getUpdates(offset?: number): Promise<BaleUpdate[]> {
  const query = offset === undefined ? "" : `?offset=${offset}`;

  return callBale<BaleUpdate[]>("getUpdates" + query);
}

async function saveResponseToFile(
  response: Response,
  filePath: string,
): Promise<void> {
  const contentLength = response.headers.get("content-length");

  if (contentLength !== null) {
    const size = Number(contentLength);

    if (Number.isFinite(size) && size > MAX_FILE_SIZE) {
      throw new Error("The downloaded file exceeds the 20 MB limit.");
    }
  }

  if (!response.body) {
    throw new Error("The download response has no body.");
  }

  let totalBytes = 0;

  const sizeLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.length;

      if (totalBytes > MAX_FILE_SIZE) {
        callback(new Error("The downloaded file exceeds the 20 MB limit."));
        return;
      }

      callback(null, chunk);
    },
  });

  const fileHandle = await open(filePath, "wx");

  try {
    await pipeline(response.body, sizeLimiter, fileHandle.createWriteStream());

    if (totalBytes === 0) {
      throw new Error("The downloaded file is empty.");
    }
  } catch (error) {
    await fileHandle.close().catch(() => {});
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath).catch(() => {});
    throw error;
  }

  await fileHandle.close();
}

export async function downloadBaleDocument(
  document: BaleDocument,
): Promise<{ filePath: string; filename: string }> {
  if (document.file_size !== undefined && document.file_size > MAX_FILE_SIZE) {
    throw new Error("The file exceeds Bale's 20 MB download limit.");
  }

  const originalName = path.basename(document.file_name ?? "document.pdf");
  const filename = `${Date.now()}-${originalName}`;
  const uploadDirectory = path.resolve(process.cwd(), "uploads");

  await mkdir(uploadDirectory, { recursive: true });

  const fileInfo = await callBale<BaleFile>("getFile", {
    file_id: document.file_id,
  });

  if (!fileInfo.file_path) {
    throw new Error("Bale did not return a file path.");
  }

  if (fileInfo.file_size !== undefined && fileInfo.file_size > MAX_FILE_SIZE) {
    throw new Error("The file exceeds Bale's 20 MB download limit.");
  }
  const response = await fetch(`${FILE_BASE_URL}/${fileInfo.file_path}`, {
    signal: AbortSignal.timeout(config.bale.downloadTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`File download failed: HTTP ${response.status}`);
  }

  const filePath = path.join(uploadDirectory, filename);

  await saveResponseToFile(response, filePath);

  return { filePath, filename: originalName };
}
