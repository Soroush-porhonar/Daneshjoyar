import { describe, expect, it } from "vitest";
import {
  abortAllForShutdown,
  cancelRequest,
  finishRequest,
  isShuttingDown,
  startRequest,
} from "../src/bot/cancellation.js";

describe("cancellation", () => {
  it("a new request in the same chat aborts the previous one", () => {
    const first = startRequest(1);
    const second = startRequest(1);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    finishRequest(1, second);
  });

  it("cancelRequest aborts the running request and says whether there was one", () => {
    const controller = startRequest(2);

    expect(cancelRequest(2)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(cancelRequest(2)).toBe(false);
  });

  it("finishing an older request keeps the newer one", () => {
    const older = startRequest(3);
    const newer = startRequest(3);
    finishRequest(3, older);

    expect(cancelRequest(3)).toBe(true);
    expect(newer.signal.aborted).toBe(true);
  });

  // Last: the shutdown state stays set for the rest of this file.
  it("a shutdown aborts every request with the reason 'shutdown'", () => {
    const a = startRequest(4);
    const b = startRequest(5);
    expect(isShuttingDown()).toBe(false);

    abortAllForShutdown();

    expect(isShuttingDown()).toBe(true);
    expect([a.signal.reason, b.signal.reason]).toEqual(["shutdown", "shutdown"]);
    expect(cancelRequest(4)).toBe(false);
  });
});
