import { config } from "../config.js";
import { logger } from "../logger.js";
import { chat } from "../llm/ollamaClient.js";
import { buildRouterSystemPrompt } from "../llm/prompts/router.js";

export type MessageRoute = "document" | "chat";

export type RetrievalMode = "focused" | "multi_part" | "broad";

export interface MessageClassification {
  route: MessageRoute;
  retrievalMode: RetrievalMode;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

const RETRIEVAL_MODES: readonly RetrievalMode[] = [
  "focused",
  "multi_part",
  "broad",
];

const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    route: { type: "string", enum: ["document", "chat"] },
    retrievalMode: { type: "string", enum: RETRIEVAL_MODES },
  },
  required: ["route", "retrievalMode"],
  additionalProperties: false,
};

/** Validates the router's raw JSON output; throws on anything unexpected. */
export function parseClassification(content: string): MessageClassification {
  let result: { route?: unknown; retrievalMode?: unknown };

  try {
    result = JSON.parse(content) as typeof result;
  } catch {
    throw new Error(`Router returned invalid JSON: ${content}`);
  }

  if (result.route !== "document" && result.route !== "chat") {
    throw new Error(`Router returned an invalid route: ${content}`);
  }

  if (
    typeof result.retrievalMode !== "string" ||
    !RETRIEVAL_MODES.includes(result.retrievalMode as RetrievalMode)
  ) {
    throw new Error(`Router returned an invalid retrieval mode: ${content}`);
  }

  if (result.route === "chat") {
    return { route: "chat", retrievalMode: "focused" };
  }

  return {
    route: "document",
    retrievalMode: result.retrievalMode as RetrievalMode,
  };
}

/**
 * The router sees only file names ("CamScanner 05-18.pdf" says nothing), so it
 * can take a question about the notes for general chat. When the early search
 * found a chunk that clearly answers the message (`topScore`, the reranker's
 * best score), the notes win.
 */
export function resolveRoute(
  classification: MessageClassification,
  topScore: number | undefined,
): MessageClassification {
  if (
    classification.route === "chat" &&
    topScore !== undefined &&
    topScore >= config.reranker.relevantScore
  ) {
    logger.info("Router said chat, but the notes clearly match:", { topScore });
    return { route: "document", retrievalMode: "focused" };
  }

  return classification;
}

export async function routeMessage(
  text: string,
  documentNames: string[],
  history: ConversationMessage[] = [],
): Promise<MessageClassification> {
  const content = await chat({
    think: false,
    format: ROUTER_SCHEMA,
    options: { num_predict: 64, temperature: config.llm.temperature.router },
    timeoutMs: config.llm.routerTimeoutMs,
    messages: [
      { role: "system", content: buildRouterSystemPrompt(documentNames) },
      ...history.slice(-config.rag.historyLimit),
      { role: "user", content: text },
    ],
  });

  logger.info("Router response:", content);

  return parseClassification(content);
}
