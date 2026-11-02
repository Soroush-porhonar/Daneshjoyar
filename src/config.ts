import "dotenv/config";

function required(key: string): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`${key} is not defined`);
  }

  return value;
}

/** Ollama accepts a duration ("30m") or a number of seconds (-1 = forever). */
function parseKeepAlive(value: string): string | number {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

export const config = {
  port: Number(required("PORT")),
  baleToken: required("BALE_TOKEN"),
  databaseUrl: required("DATABASE_URL"),

  llm: {
    url: required("LLM_URL"),
    model: required("LLM_MODEL"),
    timeoutMs: 120_000,
    routerTimeoutMs: 60_000,
    /** Ollama defaults to 4096 tokens, which silently truncates long prompts. */
    numCtx: 8192,
    /**
     * How long Ollama keeps a model in GPU memory after a request. Ollama's
     * default (5 min) made the next question after a pause wait ~10 s for the
     * model to load (measured). "-1" keeps it loaded; the GPU memory stays reserved.
     */
    keepAlive: parseKeepAlive(process.env.LLM_KEEP_ALIVE ?? "30m"),
    temperature: { rag: 0.2, router: 0, chat: 0.7 },
  },

  /** Cross-encoder reranker (llama.cpp server in compose.yaml, runs on the CPU). */
  reranker: {
    enabled: process.env.RERANKER_ENABLED !== "false",
    url: process.env.RERANKER_URL ?? "http://localhost:8081/v1/rerank",
    /** Search returns this many candidates; the reranker keeps the best few. */
    candidates: 10,
    timeoutMs: 20_000,
    /**
     * Hits the reranker scores below this are not shown to the model or cited;
     * with none left the bot says it found nothing, without an LLM call.
     * Off by default (RERANKER_MIN_SCORE to try): measured on 85 answerable and 6
     * unanswerable questions, correct chunks score -7.8 .. 7.6 and the negatives'
     * best chunk -7.4 .. -3.9, so they overlap. The best cut-off (-5) kept 84/85
     * correct chunks but rejected only 2/6 negatives, which the model refuses anyway.
     */
    minScore: process.env.RERANKER_MIN_SCORE ? Number(process.env.RERANKER_MIN_SCORE) : null,
    /**
     * A best chunk scoring at least this clearly matches the message: the bot
     * answers from the notes even if the router (which sees only file names)
     * said chat, and a summary request is about that chunk's document.
     * Measured (npm run eval:router -- --with-search, 10 documents): chat
     * messages' best chunks scored -9.0 .. -3.0, questions about the notes
     * -2.2 .. 6.2 (13 of 19 at 0 or more); unanswerable questions' best chunks
     * at most -3.9 (npm run eval). 0 keeps a 3-point margin above any chat.
     */
    relevantScore: 0,
  },

  embedding: {
    url: process.env.OLLAMA_EMBED_URL ?? "http://localhost:11434/api/embed",
    model: required("EMBEDDING_MODEL"),
    dimensions: 1024,
    timeoutMs: 120_000,
  },

  rag: {
    chunkSize: 1200,
    chunkOverlap: 200,
    /**
     * Chunking features, switchable by env to re-measure (npm run eval).
     * Measured on 65 questions / 6 documents: per-page chunks were best; the
     * cross-page and semantic variants lowered hit@1 on long notes, whose
     * pages already hold one subtopic each, so they are off by default.
     */
    chunking: {
      stripBoilerplate: process.env.CHUNK_STRIP_BOILERPLATE !== "false",
      titleInEmbedding: process.env.CHUNK_TITLE_IN_EMBEDDING !== "false",
      crossPage: process.env.CHUNK_CROSS_PAGE === "true",
      /** Running text: cut where the topic changes (sentence embeddings). */
      semantic: process.env.CHUNK_SEMANTIC === "true",
    },
    /**
     * Hybrid search: vector + keyword (full-text) results fused with Reciprocal Rank Fusion.
     * Measured on 86 questions: vector search alone already has the right page in its
     * top 10 for 82; keyword search added none (the misses are paraphrases with no
     * shared words), and after reranking the results were identical. So it is off by default.
     */
    hybridSearch: process.env.HYBRID_SEARCH === "true",
    /** RRF constant: each list adds 1 / (k + rank); 60 is the usual value. */
    rrfK: 60,
    /** Slide decks: give the model the hit's whole section (no measured effect at the current context cap). */
    sectionExpansion: process.env.SECTION_EXPANSION === "true",
    /**
     * Chunks farther than this are ignored. Calibrated with npm run eval:
     * 0.6 keeps 98% of correct pages (0.55 kept 93%). Unanswerable questions
     * overlap these distances, so the grounded prompt does the refusing.
     */
    maxCosineDistance: 0.6,
    /** Vector hits per question mode. */
    retrievalLimits: { focused: 3, multi_part: 5 },
    /** Hits plus their neighbouring chunks may fill at most this many chunks. */
    maxContextChunks: { focused: 5, multi_part: 8 },
    /** Broad mode: max characters of PDF text per extraction batch (~2.8 chars/token). */
    broadBatchChars: 9000,
    historyLimit: 10,
  },

  ocr: {
    enabled: process.env.OCR_ENABLED !== "false",
    /** Pages with fewer characters than this are treated as images. */
    minChars: 20,
    /** Optional cap on OCR'd pages per document (OCR_MAX_PAGES); unlimited by default. */
    maxPages: process.env.OCR_MAX_PAGES ? Number(process.env.OCR_MAX_PAGES) : Infinity,
    /** Measured on the GPU (RX 6800S): ~44 s per page; used for the time estimate. */
    secondsPerPage: 45,
    /** Page image width sent to the vision model (OCR_IMAGE_WIDTH); see npm run eval:ocr -- --ref. */
    imageWidth: Number(process.env.OCR_IMAGE_WIDTH ?? 1000),
    /** Prompt language (OCR_PROMPT=fa|en). */
    prompt: process.env.OCR_PROMPT === "fa" ? ("fa" as const) : ("en" as const),
    /**
     * Repair of words the model wrote reversed (OCR_REPAIR): "page" flips every
     * word when reversed common words dominate the page; "word" flips each word
     * whose reversed spelling is much more common (wordFrequencies.json).
     */
    repair: process.env.OCR_REPAIR === "word" ? ("word" as const) : ("page" as const),
    timeoutMs: 300_000,
    /** Progress every 5 pages, or every ~10% for big documents. */
    progressEvery: 5,
  },

  bale: {
    maxFileSize: 20 * 1024 * 1024,
    maxMessageLength: 4000,
    apiTimeoutMs: 30_000,
    downloadTimeoutMs: 60_000,
  },
} as const;
