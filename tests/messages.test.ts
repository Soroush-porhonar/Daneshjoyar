import { describe, expect, it } from "vitest";
import * as messages from "../src/messages.js";

/** Renders every exported message (calling the builders with sample values). */
function allMessages(): [string, string][] {
  const samples: [string, string][] = [];

  for (const [name, value] of Object.entries(messages)) {
    if (typeof value === "string") {
      samples.push([name, value]);
    } else if (name === "documentNameButton" || name === "documentInfoText") {
      // These take a document status, not numbers.
      const fn = value as (name: string, status: string) => string;
      for (const status of ["pending", "processing", "completed", "failed"]) {
        samples.push([`${name}(${status})`, fn("جزوه.pdf", status)]);
      }
    } else if (typeof value === "function") {
      const fn = value as (...args: unknown[]) => string;
      samples.push([name, fn("جزوه.pdf", 2, 3)]);
      samples.push([`${name}(zero)`, fn(0, 0, 0)]);
    } else {
      samples.push([name, Object.values(value as Record<string, string>).join("\n")]);
    }
  }

  return samples;
}

/** Removes the Latin text that is allowed: commands, PDF, and file names. */
function stripAllowed(text: string): string {
  return text
    .replace(/\/[a-z_]+/g, "")
    .replace(/\bPDF\b/g, "")
    .replace(/\S+\.pdf/gi, "");
}

describe("user-facing messages", () => {
  it.each(allMessages())("%s is Persian only", (_name, text) => {
    expect(stripAllowed(text)).not.toMatch(/[A-Za-z]/);
  });

  it.each(allMessages())("%s uses no formal شما-style endings", (_name, text) => {
    expect(text).not.toMatch(/(کنید|بفرمایید|نکرده‌اید|ببینید|بفرستید)/);
  });

  it.each(allMessages())(
    "%s keeps every command left-to-right (shows /delete 3, not 3 /delete)",
    (_name, text) => {
      for (const match of text.matchAll(/\/[a-z_]+(?: \d+)?/g)) {
        const start = match.index!;
        const end = start + match[0].length;
        expect(text[start - 1]).toBe("‎");
        expect(text[end]).toBe("‎");
      }
    },
  );

  it("shows typed commands in the form the bot actually parses", () => {
    // Help no longer lists commands (buttons do the work); the usage hints still show them.
    expect(messages.DELETE_USAGE_TEXT).toContain("/delete 1");
  });

  it("the documents list explains the buttons; the buttons show the documents", () => {
    expect(messages.DOCUMENTS_LIST_TEXT).toContain(messages.DELETE_BUTTON);
    expect(messages.DOCUMENTS_LIST_TEXT).not.toContain("شناسه");
  });
});
