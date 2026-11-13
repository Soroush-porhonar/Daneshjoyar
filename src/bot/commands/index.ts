import {
  cancelDeleteCommand,
  confirmDeleteCommand,
  deleteCommand,
  documentsCommand,
} from "./documents.js";
import { aboutCommand, helpCommand, startCommand } from "./info.js";
import { newTopicCommand } from "./topic.js";
import type { CommandContext, CommandHandler, CommandReply } from "./types.js";
import { MENU_ABOUT, MENU_DOCUMENTS, MENU_HELP, MENU_NEW_TOPIC } from "../../messages.js";

const COMMANDS: Record<string, CommandHandler> = {
  "/start": startCommand,
  "/help": helpCommand,
  "/about": aboutCommand,
  "/documents": documentsCommand,
  "/delete": deleteCommand,
  "/confirm_delete": confirmDeleteCommand,
  "/cancel_delete": cancelDeleteCommand,
  "/new": newTopicCommand,
  // Main menu keyboard buttons arrive as their label text.
  [MENU_DOCUMENTS]: documentsCommand,
  [MENU_HELP]: helpCommand,
  [MENU_ABOUT]: aboutCommand,
  [MENU_NEW_TOPIC]: newTopicCommand,
};

export interface ParsedCommand {
  handler: CommandHandler;
  args: string[];
}

/** Invisible direction marks that a copied command may contain. */
const DIRECTION_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** Returns the matching command for a message, or null for plain text. */
export function parseCommand(text: string): ParsedCommand | null {
  const clean = text.replace(DIRECTION_MARKS, "").trim();
  // Menu labels contain spaces, so match them as a whole first.
  if (Object.hasOwn(COMMANDS, clean) && !clean.startsWith("/")) {
    return { handler: COMMANDS[clean]!, args: [] };
  }

  return matchCommand(clean) ?? matchCommand(slashMovedToFront(clean));
}

/**
 * On a right-to-left keyboard students type "delete 10/" for "/delete 10"
 * (seen in real messages). Moves a trailing slash to the front; the result
 * still has to name a known command.
 */
function slashMovedToFront(text: string): string {
  return text.endsWith("/") && !text.startsWith("/") ? `/${text.slice(0, -1).trim()}` : "";
}

function matchCommand(text: string): ParsedCommand | null {
  const [name, ...args] = text.split(/\s+/);
  const handler =
    name && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;

  return handler ? { handler, args } : null;
}

export type { CommandContext, CommandReply };
