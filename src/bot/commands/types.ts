import type { Markup } from "../../bale.js";

export interface CommandContext {
  chatId: number;
  userId: number;
  /** Whitespace-separated arguments following the command name. */
  args: string[];
}

/** A reply with buttons (under the message) or a keyboard (at the bottom of the chat). */
export interface CommandReply {
  text: string;
  markup?: Markup;
  /** The user's data was deleted: the reply is sent but not saved or logged. */
  forgotUser?: boolean;
}

/** A command returns the reply to send back: plain text, or text with buttons. */
export type CommandHandler = (context: CommandContext) => Promise<string | CommandReply>;
