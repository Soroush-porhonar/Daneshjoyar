/**
 * Shows an answer while the model writes it (roadmap S1): the thinking notice
 * becomes the answer. Answers took 11 s on average before any text appeared.
 *
 * "edit" mode edits the notice as text arrives, gently: at most one edit per
 * `editIntervalMs`, only after `minGrowthChars` new characters, one call at a
 * time. Past Bale's length limit the text continues in a new message. On a
 * rate limit (429) it waits `retry_after` and doubles the interval.
 * "parts" mode (the fallback) sends up to `maxParts` messages at paragraph
 * ends and never edits them. `finish` puts the final answer, its sources and
 * the feedback buttons into the same messages.
 */
import { editMessageText, sendMessage, splitMessage } from "../bale.js";
import type { InlineButton } from "../bale.js";
import { config } from "../config.js";
import type { StreamMode } from "../config.js";
import { BaleApiError } from "../errors.js";
import { logger } from "../logger.js";
import { plainMath } from "../rag/plainMath.js";

export interface LiveAnswer {
  /** The answer so far (the whole text each time). */
  update(text: string): void;
  /** True once part of the answer is on screen. */
  readonly started: boolean;
  /** Stops showing new text (cancel or failure) and waits for a call in flight. */
  stop(): Promise<void>;
  /** What the last message shows of the answer ("" if nothing yet). */
  readonly lastMessageText: string;
  /** Message ids, in order; the last one carries the buttons. */
  readonly messageIds: readonly number[];
  /**
   * Shows the final answer in the same messages, with `buttons` on the last.
   * Returns false if Bale refused, so the caller can send it normally.
   */
  finish(text: string, buttons?: InlineButton[][]): Promise<boolean>;
}

interface Options {
  mode?: StreamMode;
  /** Buttons shown while the answer is written (the cancel button). */
  liveButtons?: InlineButton[][];
}

/** The text as shown while it is written: Unicode formulas, no half-written citation. */
export const liveText = (text: string): string =>
  plainMath(text)
    .replace(/\s*\[[\d۰-۹\s,،]*$/, "")
    .trimEnd();

const isNotModified = (error: unknown) =>
  error instanceof Error && /not modified/i.test(error.message);

const buttonsKey = (buttons: InlineButton[][] | undefined) => JSON.stringify(buttons ?? []);

export function createLiveAnswer(chatId: number, noticeId: number, options: Options = {}): LiveAnswer {
  const mode = options.mode ?? config.stream.mode;
  const liveButtons = options.liveButtons;
  // Created right after the notice is sent: the first edit's delay is the wait for the first text.
  const createdAt = Date.now();
  const ids: number[] = [noticeId];
  // What each message shows now.
  const shown: { text: string; buttons: string }[] = [];

  let latest = "";
  let stopped = false;
  let interval = config.stream.editIntervalMs;
  let lastCallAt = 0;
  let pausedUntil = 0;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  // "parts": the text already sent, as the segments it was sent in.
  const committed: string[] = [];

  const shownText = () => shown.map((part) => part.text).join("");

  /** Makes the messages show `segments`, `buttons` on the last; sends new messages as needed. */
  async function render(segments: string[], buttons: InlineButton[][] | undefined): Promise<void> {
    for (const [index, text] of segments.entries()) {
      const wanted = index === segments.length - 1 ? buttons : undefined;
      const current = shown[index];

      if (index < ids.length) {
        if (current?.text === text && current.buttons === buttonsKey(wanted)) continue;
        try {
          await editMessageText(chatId, ids[index]!, text, wanted);
        } catch (error: unknown) {
          if (!isNotModified(error)) throw error;
        }
      } else {
        const id = await sendMessage(chatId, text, wanted ? { inline: wanted } : undefined);
        if (id === undefined) throw new Error("Bale returned no message id");
        ids.push(id);
      }
      shown[index] = { text, buttons: buttonsKey(wanted) };
    }
  }

  /** Runs one Bale call sequence; a rate limit pauses and slows the stream. */
  async function call(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error: unknown) {
      if (error instanceof BaleApiError && error.isRateLimit) {
        const waitMs = (error.retryAfterSeconds ?? 5) * 1000;
        pausedUntil = Date.now() + waitMs;
        interval *= 2;
        logger.warn("[Stream] Bale rate limit", { chatId, waitMs, intervalMs: interval });
      } else {
        logger.warn("[Stream] Live update failed:", { chatId, error });
      }
    } finally {
      lastCallAt = Date.now();
    }
  }

  /** "parts": the segments to send now, or null if no paragraph end is far enough yet. */
  function nextParts(text: string): string[] | null {
    if (committed.length >= config.stream.maxParts - 1) return null; // the last part is the final one
    const sent = committed.join("").length;
    const end = text.lastIndexOf("\n\n");
    if (end - sent < config.stream.minPartChars) return null;
    // Not inside a code block.
    if ((text.slice(0, end).match(/```/g) ?? []).length % 2 === 1) return null;
    return [...committed, text.slice(sent, end + 2)];
  }

  function flush(): void {
    timer = null;
    if (stopped || inFlight) return;

    const text = liveText(latest);
    let segments: string[] | null;
    if (mode === "parts") {
      segments = nextParts(text);
      if (segments) committed.splice(0, committed.length, ...segments);
    } else {
      segments = text.length - shownText().length >= config.stream.minGrowthChars ? splitMessage(text) : null;
    }
    if (!segments) return;

    const parts = mode === "parts" ? segments.map((part) => part.trim()) : segments;
    const first = shown.length === 0;
    inFlight = call(async () => {
      await render(parts, liveButtons);
      if (first) logger.info("[Stream] First text shown", { chatId, ms: Date.now() - createdAt });
    }).finally(() => {
      inFlight = null;
      schedule();
    });
  }

  function schedule(): void {
    if (stopped || timer || inFlight || mode === "off") return;
    const wait = Math.max(0, lastCallAt + interval - Date.now(), pausedUntil - Date.now());
    timer = setTimeout(flush, wait);
  }

  async function halt(): Promise<void> {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    await inFlight;
  }

  return {
    update(text) {
      latest = text;
      schedule();
    },
    get started() {
      return shown.length > 0;
    },
    get lastMessageText() {
      return shown.at(-1)?.text ?? "";
    },
    get messageIds() {
      return ids;
    },
    stop: halt,
    async finish(text, buttons) {
      await halt();
      const sentBefore = committed.map((part) => part.trim());
      const already = committed.join("");
      // "parts": the parts already sent stay; the rest of the answer follows them.
      const segments =
        mode === "parts" && committed.length > 0 && text.startsWith(already)
          ? [...sentBefore, ...splitMessage(text.slice(already.length).trim())]
          : splitMessage(text);

      const attempt = () => render(segments, buttons);
      try {
        await attempt();
        return true;
      } catch (error: unknown) {
        if (error instanceof BaleApiError && error.isRateLimit) {
          logger.warn("[Stream] Bale rate limit on the final answer", { chatId });
          await new Promise((resolve) => setTimeout(resolve, (error.retryAfterSeconds ?? 5) * 1000));
          return attempt().then(
            () => true,
            () => false,
          );
        }
        logger.warn("[Stream] Final answer could not be shown in place:", { chatId, error });
        return false;
      }
    },
  };
}
