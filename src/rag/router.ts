import { config } from "../config.js";
import { logger } from "../logger.js";
import { trimHistory } from "../llm/history.js";
import { chat } from "../llm/ollamaClient.js";
import { buildRouterSystemPrompt } from "../llm/prompts/router.js";
import { cleanRewrite } from "./rewrite.js";

/**
 * document_info: a question about a document itself (what it is about, who
 * wrote it, its topics). Decided by a rule (isDocumentInfoQuestion in
 * documentInfo.ts), not by the router: as a third router value it got 3 of 6
 * such messages right (none of the 3 real ones) and cost route+mode 94 -> 85%
 * on the other cases (eval:router 2026-11-13). transform: a request to reshape
 * the previous answer, also decided by a rule (isTransformRequest in transform.ts).
 */
export type MessageRoute = "document" | "document_info" | "transform" | "chat";

/** What the router model may answer. */
const ROUTER_ROUTES = ["document", "chat"] as const;

export type RetrievalMode = "focused" | "multi_part" | "broad";

export interface MessageClassification {
  route: MessageRoute;
  retrievalMode: RetrievalMode;
  /**
   * The message cannot be understood without the conversation ("explain more",
   * "what about the second one?"). Absent when the router was not asked.
   */
  dependsOnHistory?: boolean;
  /**
   * The router's standalone version of a message that depends on the history,
   * checked with cleanRewrite; null when it was missing or unusable (the caller
   * then rewrites with the separate call).
   */
  standaloneQuestion?: string | null;
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
    route: { type: "string", enum: ROUTER_ROUTES },
    retrievalMode: { type: "string", enum: RETRIEVAL_MODES },
    dependsOnHistory: { type: "boolean" },
    standaloneQuestion: { type: "string" },
  },
  required: ["route", "retrievalMode", "dependsOnHistory", "standaloneQuestion"],
  additionalProperties: false,
};

/** Validates the router's raw JSON output; throws on anything unexpected. */
export function parseClassification(content: string): MessageClassification {
  let result: { route?: unknown; retrievalMode?: unknown; dependsOnHistory?: unknown; standaloneQuestion?: unknown };

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

  // The follow-up decision is optional: a router answer without it still routes.
  const followUp =
    typeof result.dependsOnHistory === "boolean"
      ? {
          dependsOnHistory: result.dependsOnHistory,
          standaloneQuestion:
            result.dependsOnHistory && typeof result.standaloneQuestion === "string"
              ? cleanRewrite(result.standaloneQuestion)
              : null,
        }
      : {};

  if (result.route === "chat") {
    return { route: "chat", retrievalMode: "focused", ...followUp };
  }

  return {
    route: "document",
    retrievalMode: result.retrievalMode as RetrievalMode,
    ...followUp,
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
    return { ...classification, route: "document", retrievalMode: "focused" };
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
    // Room for the standalone question (a sentence or two of Persian).
    options: { num_predict: 200, temperature: config.llm.temperature.router },
    timeoutMs: config.llm.routerTimeoutMs,
    messages: [
      { role: "system", content: buildRouterSystemPrompt(documentNames) },
      ...trimHistory(history, config.rag.routerHistory),
      { role: "user", content: text },
    ],
  });

  // The reply holds the student's words (standaloneQuestion): debug only (roadmap 8.10).
  logger.debug("Router response:", content);

  const classification = parseClassification(content);
  logger.info("Router:", {
    route: classification.route,
    retrievalMode: classification.retrievalMode,
    dependsOnHistory: classification.dependsOnHistory,
  });

  // Without an earlier exchange nothing can depend on it.
  return history.length === 0
    ? { ...classification, dependsOnHistory: false, standaloneQuestion: null }
    : classification;
}
