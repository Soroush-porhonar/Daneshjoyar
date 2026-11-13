import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaleUpdate } from "../src/bale.js";
import type { InboxUpdate } from "../src/db/updates.js";

vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../src/db/updates.js", () => ({
  listUnfinishedUpdates: vi.fn(),
  claimRetry: vi.fn(),
  abandonUpdate: vi.fn(),
  hasLaterMessage: vi.fn(),
}));
vi.mock("../src/bot/dispatcher.js", () => ({ routeUpdate: vi.fn(), runningUpdates: vi.fn(() => [5]) }));

const { sweepInbox } = await import("../src/bot/sweeper.js");
const { sendMessage } = await import("../src/bale.js");
const { listUnfinishedUpdates, claimRetry, abandonUpdate, hasLaterMessage } = await import("../src/db/updates.js");
const { routeUpdate } = await import("../src/bot/dispatcher.js");
const { logger } = await import("../src/logger.js");
const messages = await import("../src/messages.js");
const { config } = await import("../src/config.js");

const nowSeconds = () => Math.floor(Date.now() / 1000);

const inbox = (payload: Omit<BaleUpdate, "update_id">, extra: Partial<InboxUpdate> = {}): InboxUpdate => ({
  updateId: 1,
  status: "failed",
  attempts: 1,
  payload: { update_id: 1, ...payload },
  receivedAt: new Date(),
  ...extra,
});

const text = (secondsAgo = 10) => ({ message: { chat: { id: 7 }, date: nowSeconds() - secondsAgo, text: "سؤال" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.mocked(claimRetry).mockResolvedValue(true);
  vi.mocked(hasLaterMessage).mockResolvedValue(false);
});

describe("sweepInbox", () => {
  it("asks for unfinished updates, leaving out the ones running now", async () => {
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([]);

    await sweepInbox();

    expect(listUnfinishedUpdates).toHaveBeenCalledWith(config.inbox.staleMs, [5]);
  });

  it("retries a failed message", async () => {
    const update = inbox(text());
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([update]);

    await sweepInbox();

    expect(claimRetry).toHaveBeenCalledWith(1, "failed");
    expect(routeUpdate).toHaveBeenCalledWith(update.payload);
  });

  it("does not retry what it could not claim", async () => {
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([inbox(text())]);
    vi.mocked(claimRetry).mockResolvedValue(false);

    await sweepInbox();

    expect(routeUpdate).not.toHaveBeenCalled();
  });

  it("gives up after the last attempt and asks the student to send it again", async () => {
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([inbox(text(), { attempts: config.inbox.maxAttempts })]);

    await sweepInbox();

    expect(routeUpdate).not.toHaveBeenCalled();
    expect(abandonUpdate).toHaveBeenCalledWith(1);
    expect(sendMessage).toHaveBeenCalledWith(7, messages.MESSAGE_NOT_ANSWERED_TEXT);
  });

  it("does not answer a message late", async () => {
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([inbox(text(config.inbox.maxAgeMs / 1000 + 60))]);

    await sweepInbox();

    expect(routeUpdate).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(7, messages.MESSAGE_NOT_ANSWERED_TEXT);
  });

  it("retries an old upload (the file can still be downloaded)", async () => {
    const upload = { message: { chat: { id: 7 }, date: nowSeconds() - 3600, document: { file_id: "f", file_name: "a.pdf" } } };
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([inbox(upload, { status: "received" })]);

    await sweepInbox();

    expect(claimRetry).toHaveBeenCalledWith(1, "received");
    expect(routeUpdate).toHaveBeenCalled();
  });

  it("names the file when it gives up on an upload", async () => {
    const upload = { message: { chat: { id: 7 }, document: { file_id: "f", file_name: "a.pdf" } } };
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([inbox(upload, { attempts: config.inbox.maxAttempts })]);

    await sweepInbox();

    expect(sendMessage).toHaveBeenCalledWith(7, messages.uploadInterruptedText("a.pdf"));
  });

  it("drops a message the student followed with a newer one, silently", async () => {
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([inbox(text())]);
    vi.mocked(hasLaterMessage).mockResolvedValue(true);

    await sweepInbox();

    expect(routeUpdate).not.toHaveBeenCalled();
    expect(abandonUpdate).toHaveBeenCalledWith(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("gives up on an old button press without a message", async () => {
    const press = { callback_query: { id: "cb", data: "docs", message: { message_id: 1, chat: { id: 7 } } } };
    const old = new Date(Date.now() - config.inbox.maxAgeMs - 60_000);
    vi.mocked(listUnfinishedUpdates).mockResolvedValue([inbox(press, { receivedAt: old })]);

    await sweepInbox();

    expect(abandonUpdate).toHaveBeenCalledWith(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("survives a database error", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.mocked(listUnfinishedUpdates).mockRejectedValue(new Error("db down"));

    await expect(sweepInbox()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
