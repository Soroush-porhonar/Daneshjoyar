import { ANSWER_CUT_TEXT } from "../messages.js";

/**
 * A reply Ollama stopped at the output cap (done_reason "length", see
 * config.llm.maxTokens) gets ANSWER_CUT_TEXT after it, so the student knows
 * the end is missing.
 */
export const markCut = (answer: string, doneReason: string | undefined): string =>
  doneReason === "length" ? `${answer}\n\n${ANSWER_CUT_TEXT}` : answer;
