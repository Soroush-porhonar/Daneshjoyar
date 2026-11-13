import { describe, expect, it } from "vitest";
import { trimHistory } from "../src/llm/history.js";
import { SOURCES_HEADING } from "../src/messages.js";

const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

describe("trimHistory", () => {
  it("keeps only the last turns", () => {
    const history = [user("۱"), assistant("۲"), user("۳"), assistant("۴")];

    expect(trimHistory(history, { messages: 2, chars: 100 })).toEqual([user("۳"), assistant("۴")]);
  });

  it("drops an answer's source list", () => {
    const history = [assistant(`جواب [1]\n\n${SOURCES_HEADING}\n- [1] notes — صفحه 3`)];

    expect(trimHistory(history, { messages: 6, chars: 600 })).toEqual([assistant("جواب [1]")]);
  });

  it("cuts a long turn and marks the cut", () => {
    const [trimmed] = trimHistory([assistant("الف".repeat(500))], { messages: 6, chars: 600 });

    expect(trimmed!.content).toHaveLength(601);
    expect(trimmed!.content.endsWith("…")).toBe(true);
  });

  it("leaves a student's message with the heading's words alone", () => {
    expect(trimHistory([user(`${SOURCES_HEADING} چیه؟`)], { messages: 6, chars: 600 })).toEqual([
      user(`${SOURCES_HEADING} چیه؟`),
    ]);
  });

  it("keeps other fields", () => {
    expect(trimHistory([{ ...user("سلام"), id: 7 }], { messages: 6, chars: 600 })).toEqual([{ ...user("سلام"), id: 7 }]);
  });
});
