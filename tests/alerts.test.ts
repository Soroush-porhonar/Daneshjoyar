import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn(async () => 1) }));

const { recordFailure, resetAlerts } = await import("../src/alerts.js");
const { sendMessage } = await import("../src/bale.js");
const { config } = await import("../src/config.js");
const { logger } = await import("../src/logger.js");
const messages = await import("../src/messages.js");

const alerts = config.alerts as { adminChatId: number | null };
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const MINUTE = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  resetAlerts();
  alerts.adminChatId = 99;
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

describe("admin alerts", () => {
  it("alerts at the third Ollama failure within ten minutes, not before", async () => {
    recordFailure("ollama", 0);
    recordFailure("ollama", 1 * MINUTE);
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();

    recordFailure("ollama", 2 * MINUTE);
    await flush();
    expect(sendMessage).toHaveBeenCalledWith(99, messages.adminAlertText("ollama", 3, 10));
  });

  it("forgets failures older than the window", async () => {
    recordFailure("ollama", 0);
    recordFailure("ollama", 1 * MINUTE);
    recordFailure("ollama", 12 * MINUTE);
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("alerts once per kind per quiet period", async () => {
    recordFailure("gpu", 0);
    recordFailure("gpu", 5 * MINUTE);
    recordFailure("queue", 6 * MINUTE);
    await flush();
    expect(vi.mocked(sendMessage).mock.calls.map(([, text]) => text)).toEqual([
      messages.adminAlertText("gpu", 1, 10),
      messages.adminAlertText("queue", 1, 10),
    ]);

    recordFailure("gpu", 31 * MINUTE);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it("only logs without an admin chat", async () => {
    alerts.adminChatId = null;

    recordFailure("gpu", 0);
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("never throws when the alert cannot be sent", async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("bale down"));

    expect(() => recordFailure("gpu", 0)).not.toThrow();
    await flush();
  });
});
