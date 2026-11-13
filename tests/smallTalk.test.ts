import { describe, expect, it } from "vitest";
import { smallTalkReply } from "../src/chat/smallTalk.js";
import { BYE_REPLY_TEXT, GREETING_REPLY_TEXT, THANKS_REPLY_TEXT } from "../src/messages.js";

describe("smallTalkReply", () => {
  it.each(["سلام", "سلام، چطوری؟", "سلام حالت چطوره", "سلاااام 👋", "hi", "Hello!", "خوبی؟", "درود ربات"])(
    "answers the greeting %s",
    (text) => {
      expect(smallTalkReply(text)).toBe(GREETING_REPLY_TEXT);
    },
  );

  it.each(["مرسی", "خیلی ممنون!", "ممنونم 🙏", "دمت گرم", "Thanks", "مرسی خیلی"])("answers the thanks %s", (text) => {
    expect(smallTalkReply(text)).toBe(THANKS_REPLY_TEXT);
  });

  it.each(["خداحافظ", "بای", "شب بخیر"])("answers the goodbye %s", (text) => {
    expect(smallTalkReply(text)).toBe(BYE_REPLY_TEXT);
  });

  it.each([
    "سلام، LIFO چیه؟",
    "سلام خلاصه جزوه رو بگو",
    "مرسی، حالا مثال بزن",
    "سیستم خبره چیه",
    "خلاصه کن",
    "خوبی‌های شی گرایی چیه؟",
    "",
    "؟",
  ])("leaves %s to the normal path", (text) => {
    expect(smallTalkReply(text)).toBeNull();
  });
});
