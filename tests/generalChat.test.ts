import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/llm/ollamaClient.js", () => ({ chat: vi.fn() }));

const { askAI } = await import("../src/llm/generalChat.js");
const { chat } = await import("../src/llm/ollamaClient.js");
const { ANSWER_CUT_TEXT } = await import("../src/messages.js");

const stats = (doneReason: string) => ({
  promptTokens: 1,
  outputTokens: 1,
  loadMs: 0,
  promptEvalMs: 0,
  evalMs: 0,
  totalMs: 0,
  doneReason,
});

describe("askAI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("caps the reply at 1000 tokens", async () => {
    vi.mocked(chat).mockResolvedValue("جواب");

    await askAI([{ role: "user", content: "یه جوک بگو" }]);

    expect(vi.mocked(chat).mock.calls[0]![0].options?.num_predict).toBe(1000);
  });

  it("says so when the cap cut the reply off", async () => {
    vi.mocked(chat).mockImplementation(async (request) => {
      request.onStats?.(stats("length"));
      return "جواب نیمه";
    });

    expect(await askAI([{ role: "user", content: "یه داستان بگو" }])).toBe(`جواب نیمه\n\n${ANSWER_CUT_TEXT}`);
  });

  it("returns a finished reply unchanged", async () => {
    vi.mocked(chat).mockImplementation(async (request) => {
      request.onStats?.(stats("stop"));
      return "جواب";
    });

    expect(await askAI([{ role: "user", content: "یه جوک بگو" }])).toBe("جواب");
  });
});
