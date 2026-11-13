/**
 * Greetings, thanks and goodbyes answered without a model call (roadmap S5):
 * "سلام، چطوری؟" took 9 to 38 seconds through the router and general chat.
 * Only messages made of these phrases alone match; anything with a question
 * or another word ("سلام، LIFO چیه؟") goes the normal way.
 */
import { BYE_REPLY_TEXT, GREETING_REPLY_TEXT, THANKS_REPLY_TEXT } from "../messages.js";
import { normalizeText } from "../rag/textQuality.js";

const GREETING = "(?:سلام|درود|هلو|های|hi|hello|hey|salam|slm)";
const HOW_ARE_YOU =
  "(?:چطوری|چطورین|چطورید|خوبی|خوبین|خوبید|حالت (?:چطوره|خوبه)|حالتون (?:چطوره|خوبه)|چه خبر|خوب هستی)";
const THANKS =
  "(?:مرسی|ممنون|ممنونم|متشکرم|متشکر|مچکرم|سپاس|سپاسگزارم|تشکر|دمت گرم|دستت درد نکنه|thanks|thank you|thx|merci|mrc)";
const BYE = "(?:خداحافظ|خدانگهدار|بای|فعلا|شب بخیر|bye|bye bye)";
const POLITE = "(?:عزیز|جان|دوست من|رفیق|ربات|بات)";

const PATTERNS: [RegExp, string][] = [
  [new RegExp(`^(?:${GREETING}(?: ${POLITE})?(?: ${HOW_ARE_YOU})?|${HOW_ARE_YOU})$`), GREETING_REPLY_TEXT],
  [new RegExp(`^(?:خیلی |بسیار )?${THANKS}(?: ${POLITE})?(?: (?:خیلی|زیاد|واقعا|${THANKS}))*$`), THANKS_REPLY_TEXT],
  [new RegExp(`^${BYE}(?: ${POLITE})?$`), BYE_REPLY_TEXT],
];

/** The text reduced to lower-case words: no punctuation, emoji, half-spaces or repeated letters. */
function words(text: string): string {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[‌‍]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The reply to a message that is only a greeting, thanks or goodbye; null otherwise. */
export function smallTalkReply(text: string): string | null {
  const normalized = words(text);
  if (normalized.length === 0 || normalized.length > 40) return null;
  return PATTERNS.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}
