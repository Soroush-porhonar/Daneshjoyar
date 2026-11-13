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

export type StreamMode = "edit" | "parts" | "off";

function parseStreamMode(value: string): StreamMode {
  if (value === "edit" || value === "parts" || value === "off") return value;
  throw new Error(`STREAM_MODE must be edit, parts or off, not "${value}"`);
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
    /**
     * Output caps (tokens) against a runaway answer: at ~37 tokens/s the old
     * 4096 let a looping answer run ~110 s. Set above every real answer in
     * answer_logs (2026-11-13: longest focused 1436 chars, multi-part 2384,
     * chat 2269, about 2.5 chars a token) and the benchmark (p95 241 tokens),
     * so they cut nothing today. A shorter-answer prompt was not tried: answers
     * are already short (focused p50 532 chars) and generation is ~5 s of ~11.
     * Whole-document summaries keep `summary`.
     */
    maxTokens: { focused: 1000, multiPart: 2000, chat: 1000, summary: 4096 },
  },

  /** Cross-encoder reranker (llama.cpp server in compose.yaml, runs on the CPU). */
  reranker: {
    enabled: process.env.RERANKER_ENABLED !== "false",
    url: process.env.RERANKER_URL ?? "http://localhost:8081/v1/rerank",
    /** Search returns this many candidates; the reranker keeps the best few. */
    candidates: 10,
    /**
     * P1: rerank the whole de-duplicated union of the chunk and question-index
     * searches, up to this many, instead of the fused top `candidates`
     * (a chunk could be cut before the reranker saw it). RERANK_CANDIDATES;
     * 10 = the fused top 10 as before. 16 changed no rank and no page in
     * context on 178 questions, rerank hit@1 84 → 84% (retrieval
     * 2026-11-13T03-38-10 vs 02-26-34), so it stays 10.
     */
    maxCandidates: Number(process.env.RERANK_CANDIDATES ?? 10),
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
    /**
     * Enriched documents (src/rag/enrich.ts): search chunks by their embedding
     * with the document title and a context sentence in front, and let the
     * reranker read the same text (CHUNK_CONTEXT). Measured on 93 questions
     * over 8 enriched documents (npm run eval, all-documents search): rerank
     * hit@1 85% -> 82%, hit@3 95% -> 91% (a dozen questions slipped from
     * rank 1 to 2 on the long notes), although fewer top-3 chunks came from
     * the wrong document (8.6% -> 5.4%). With the reranker reading the plain
     * chunk instead: no gain (hit@1 84%, in context 96% -> 94%). So it is off.
     */
    chunkContext: process.env.CHUNK_CONTEXT === "true",
    /**
     * Also search the questions each enriched chunk answers, fused with the
     * chunk search by RRF (QUESTION_INDEX=false to switch off). Same 93
     * questions: no question got worse, 4 improved (3 on the scanned handout,
     * whose OCR text is noisy but whose generated questions are clean),
     * hit@10 before reranking 96% -> 99%; answers (npm run eval:answers)
     * 43 -> 44 of 54 passed, judged faithful 52 -> 53. Within the bootstrap
     * noise, but never worse; the extra search takes ~10 ms (1,375 questions).
     */
    questionIndex: process.env.QUESTION_INDEX !== "false",
    /** Summary requests: max characters of stored section summaries in the one synthesis call. */
    storedSummaryChars: 16_000,
    /** Slide decks: give the model the hit's whole section (no measured effect at the current context cap). */
    sectionExpansion: process.env.SECTION_EXPANSION === "true",
    /**
     * Chunks farther than this are ignored. Calibrated with npm run eval:
     * 0.6 keeps 98% of correct pages (0.55 kept 93%). Unanswerable questions
     * overlap these distances, so the grounded prompt does the refusing.
     */
    maxCosineDistance: 0.6,
    /**
     * P2: search candidates up to this distance (the reranker then orders
     * them); 0.6 = maxCosineDistance as before. CANDIDATE_MAX_DISTANCE.
     * 0.65 and 0.7 gave the same result: finglish fi-lifo came into context,
     * fi-lisbon-date fell out, in context 96% either way; fi-oo-principles'
     * page is not in the top 10 at any cut-off (2026-11-13T04-10-57, 04-43-46).
     */
    candidateMaxDistance: Number(process.env.CANDIDATE_MAX_DISTANCE ?? 0.6),
    /**
     * P4: normalise the question like the chunks were at upload (Arabic ي/ك,
     * zero-width and direction marks, odd spaces) before searching.
     * NORMALIZE_QUESTION=true to switch on. No rank changed on 178 questions
     * (the #arabic_letters and #typo rows were already 100% in context;
     * BGE-M3 treats the letter forms alike): 2026-11-13T02-59-03. Off.
     */
    normalizeQuestion: process.env.NORMALIZE_QUESTION === "true",
    /**
     * P3: questions naming several concepts ("X و Y") are searched per concept
     * too, merged, and reranked against the whole question. CONCEPT_SEARCH.
     * Every part in context 15 → 14 of 17, in context unchanged at 96%
     * (2026-11-13T05-16-08): the reranker already sees both parts. Off.
     */
    conceptSearch: process.env.CONCEPT_SEARCH === "true",
    /** Vector hits per question mode. */
    retrievalLimits: { focused: 3, multi_part: 5 },
    /** Hits plus their neighbouring chunks may fill at most this many chunks. */
    maxContextChunks: { focused: 5, multi_part: 8 },
    /** Broad mode: max characters of PDF text per extraction batch (~2.8 chars/token). */
    broadBatchChars: 9000,
    historyLimit: 10,
    /**
     * What the router reads of the history (trimHistory). After 5 long answers
     * (9266 chars) the whole history was 4317 prompt tokens: 12.8 s reading,
     * 18.5 s routing; trimmed, 1581 tokens, 4.0 s and 5.2 s (uncached, 3 runs,
     * 2026-11-13). eval:router -- --with-search held at 62/62, real 24/24,
     * follow-ups missed 0 (standalone rewritten 1/20, was 0/20).
     */
    routerHistory: { messages: 6, chars: 600 },
    /**
     * General chat keeps longer turns: "continue the story" needs the story.
     */
    chatHistory: { messages: 6, chars: 1500 },
    /**
     * Earlier turns older than this are not shown to the router, the rewrite or
     * general chat: each student has one conversation for ever, so a question
     * days later was read as a follow-up of an old topic (roadmap R5). Not an
     * eval number: eval histories are always recent. "🆕 موضوع جدید" / /new
     * starts a fresh history at once.
     */
    historyMaxAgeMinutes: Number(process.env.HISTORY_MAX_AGE_MINUTES ?? 60),
  },

  ocr: {
    enabled: process.env.OCR_ENABLED !== "false",
    /** Pages with fewer characters than this are treated as images. */
    minChars: 20,
    /** Optional cap on OCR'd pages per document (OCR_MAX_PAGES); unlimited by default. */
    maxPages: process.env.OCR_MAX_PAGES ? Number(process.env.OCR_MAX_PAGES) : Infinity,
    /** Measured on the GPU (RX 6800S): ~44 s per page; used for the time estimate. */
    secondsPerPage: 45,
    /**
     * Width a page is rendered at for OCR (OCR_RENDER_WIDTH; OCR_IMAGE_WIDTH
     * is the old name). Phone scans hold more: the CamScanner handout embeds
     * ~2,350 px per page. Sent as one image, 1400 px took 1 min 50 s per page
     * (1000 px: ~50 s) and the next request crashed the GPU driver (Vulkan
     * "device lost"): the vision encoder attends over all patches at once
     * (cost grows with their square) and Ollama reserves its memory for
     * 1472 x 1472 px. So bigger pages are read in strips (tilePixels).
     * Measured on 5 scanned pages with hand-typed reference text (npm run
     * eval:ocr -- --ref, English prompt, repair "both"): one 1000 px image
     * 37.0% character errors at 49 s/page; cropped and read in strips,
     * 1200 px 11.4% (44 s), 1400 px 4.0% (40 s, 2 strips), 1800 px 4.8%
     * (67 s, 2-3 strips). Below 1400 px the reads were also erratic (7-70%
     * per page, lines left out); from 1400 px every page was 1.4-10%.
     * The handout re-read at 1400 px (39 s/page): its 7 eval questions all
     * found the right page first (before 5), its answers passed 8/8 (before 4/8).
     */
    renderWidth: Number(process.env.OCR_RENDER_WIDTH ?? process.env.OCR_IMAGE_WIDTH ?? 1400),
    /**
     * Most pixels in one image sent to the vision model (OCR_TILE_PIXELS);
     * taller pages are cut into horizontal strips between text lines.
     * Default: about a 1000 px A4 page, the size measured as safe.
     */
    tilePixels: Number(process.env.OCR_TILE_PIXELS ?? 1000 * 1414),
    /**
     * Crop a page's empty margins before reading it (OCR_CROP=false to switch
     * off): the text gets more of each strip's pixels. Same pages at 1400 px:
     * 4.0% errors at 40 s/page cropped, 3.5% at 72 s/page uncropped.
     */
    crop: process.env.OCR_CROP !== "false",
    /**
     * Prompt language (OCR_PROMPT=fa|en). At 1000 px on 3 scanned pages
     * (npm run eval:ocr -- --ref) English was better: 18.6% character errors
     * against 22.8%. At today's 1400 px cropped strips, on 5 pages, Persian is
     * 3.2% against 4.0% (36 s/page either way), and on a photo of handwritten
     * notes only the Persian prompt read the small Persian notes beside the
     * English text («واریانس خطا»); the English prompt left them out. Its
     * formulas come out in LaTeX, which cleanOcrText turns into plain text.
     */
    prompt: process.env.OCR_PROMPT === "en" ? ("en" as const) : ("fa" as const),
    /**
     * Repair of words the model wrote reversed (OCR_REPAIR):
     * - "page": flip every word when reversed common words dominate the page,
     * - "word": flip each word whose reversed spelling is much more common,
     * - "both": flip the page only if, over all known words, it reads far
     *   better flipped; then the word repair for what is left.
     * Same 3 pages: none 41.5%, word 20.4%, page 18.6%, both 15.5% (page 2
     * came out fully reversed, pages 1 and 5 partly; "both" is best on each).
     * What remains is misread letters, which no repair fixes.
     */
    repair:
      process.env.OCR_REPAIR === "page" || process.env.OCR_REPAIR === "word"
        ? process.env.OCR_REPAIR
        : ("both" as const),
    timeoutMs: 300_000,
    /** Progress every 5 pages, or every ~10% for big documents. */
    progressEvery: 5,
  },

  /** Upload-time enrichment (src/rag/enrich.ts), in the background after a document is usable. */
  enrichment: {
    /** ENRICHMENT=false: new uploads are not queued (npm run enrich still works). */
    enabled: process.env.ENRICHMENT !== "false",
    /** How often the worker looks for queued documents when idle. */
    pollMs: 30_000,
  },

  /**
   * How an answer appears while it is written (roadmap S1). "edit": the
   * thinking notice is edited as text arrives; Bale documents no limit for
   * edits but answers a rate limit with 429 and retry_after, which doubles the
   * interval for the rest of that answer. "parts": the fallback if 429s show
   * up in use, at most `maxParts` messages sent at paragraph ends, never
   * edited. "off": the whole answer at the end, as before.
   */
  stream: {
    mode: parseStreamMode(process.env.STREAM_MODE ?? "edit"),
    /** At most one edit per interval, and only after this much new text. */
    editIntervalMs: 1_500,
    minGrowthChars: 40,
    /** "parts": a part is sent once this much new text ends in a paragraph. */
    minPartChars: 600,
    maxParts: 3,
  },

  bale: {
    maxFileSize: 20 * 1024 * 1024,
    maxMessageLength: 4000,
    apiTimeoutMs: 30_000,
    /** getUpdates long-poll wait; Bale caps it at about 25 s (see getUpdates). */
    pollTimeoutSeconds: 25,
    /** Waits before each repeat of a failed call (callBale); three repeats at most. */
    retryDelaysMs: [1_000, 2_000, 4_000],
    /** A longer retry_after is cut to this, so a student is not kept waiting for minutes. */
    maxRetryAfterMs: 30_000,
    downloadTimeoutMs: 60_000,
  },
} as const;
