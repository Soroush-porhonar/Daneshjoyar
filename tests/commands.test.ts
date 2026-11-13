import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/bot/commands/index.js";
import { MENU_ABOUT, MENU_DOCUMENTS, MENU_HELP, MENU_NEW_TOPIC } from "../src/messages.js";
import { newTopicCommand } from "../src/bot/commands/topic.js";

describe("parseCommand", () => {
  it("returns null for plain text", () => {
    expect(parseCommand("what is a database?")).toBeNull();
  });

  it("parses a command with arguments", () => {
    const parsed = parseCommand("  /delete   3 ");

    expect(parsed?.args).toEqual(["3"]);
  });

  it("does not treat inherited object keys as commands", () => {
    expect(parseCommand("constructor")).toBeNull();
    expect(parseCommand("toString")).toBeNull();
  });

  it("ignores unknown slash commands", () => {
    expect(parseCommand("/unknown")).toBeNull();
  });

  it("accepts a command copied together with its invisible direction marks", () => {
    const parsed = parseCommand("‎/delete 3‎");

    expect(parsed?.args).toEqual(["3"]);
  });

  it("maps the main menu buttons to their commands", () => {
    expect(parseCommand(MENU_DOCUMENTS)).not.toBeNull();
    expect(parseCommand(MENU_HELP)).not.toBeNull();
    expect(parseCommand(MENU_ABOUT)).not.toBeNull();
  });

  it("starts a new topic from the menu button or /new", () => {
    expect(parseCommand(MENU_NEW_TOPIC)?.handler).toBe(newTopicCommand);
    expect(parseCommand("/new")?.handler).toBe(newTopicCommand);
  });

  it("does not treat a question that merely mentions a menu label as a command", () => {
    expect(parseCommand(`${MENU_HELP} برای چیه؟`)).toBeNull();
  });
});
