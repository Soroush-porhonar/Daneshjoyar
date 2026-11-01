# Daneshjoyar — AI Study Assistant

**An AI-powered study assistant for Bale Messenger that answers questions from uploaded PDFs — including scanned ones — handles follow-up questions, and manages study documents. Runs fully locally.**

Built with TypeScript, Node.js, PostgreSQL, pgvector, Ollama, and Qwen 3.5 9B.

## Screenshots

<p align="center">
  <img src="screenshots/Screenshot_20261025_201501_Bale.jpg" width="18%" alt="Start Screen" />
  <img src="screenshots/Screenshot_20261025_202152_Bale.jpg" width="18%" alt="Multi Language Support" />
  <img src="screenshots/Screenshot_20261025_202331_Bale.jpg" width="18%" alt="Document Support" />
  <img src="screenshots/Screenshot_20261025_202413_Bale.jpg" width="18%" alt="Precise RAG Responses" />
  <img src="screenshots/Screenshot_20261025_202440_Bale.jpg" width="18%" alt="Multiple Document Management" />
</p>

## Features

- **PDF Management:** Upload, process, list, select, and delete study documents.
- **Document-Grounded Q&A:** Answer questions using passages retrieved from uploaded PDFs, with inline numbered citations ([1], [2]) and a sources list of only the pages the answer cites; refusals list no sources.
- **Scanned & Broken PDFs:** Pages with no text layer, junk text, or severely broken Persian letters are read by a local vision model (hybrid OCR, no page limit), with a time estimate and progress updates in the chat.
- **Intelligent Query Routing:** Classify messages and choose between document-based answers and general chat.
- **Adaptive Retrieval:** Focused, multi-part, or broad strategies; hits are expanded with neighbouring chunks for context.
- **Follow-Up Understanding:** Short follow-ups ("explain more") are rewritten into standalone questions using the conversation, and the pages of the previous answer compete with the new search results.
- **Long-Document Summarization:** Summarize document batches sized to the model's context window, then combine them.
- **Non-Blocking & Cancellable:** Slow work runs in the background; `/cancel` stops a running request.
- **Buttons:** A main-menu keyboard, select/delete buttons under the document list, yes/no delete confirmation and a cancel button while answering; typed commands still work and are shown so they render correctly in right-to-left text.
- **Feedback Loop:** Every answer has 👍/👎 buttons; answers and votes are logged, and disliked answers become draft evaluation questions.

## Technical Highlights

| Component          | Implementation                                                                   |
| ------------------ | -------------------------------------------------------------------------------- |
| Backend            | Node.js, TypeScript                                                              |
| Messaging          | Bale Bot API (long polling, idempotent update processing)                        |
| Database           | PostgreSQL, node-pg-migrate migrations                                           |
| Vector search      | pgvector (cosine distance, relevance threshold)                                  |
| Embeddings         | BGE-M3 (1024-d, batched)                                                         |
| LLM inference      | Ollama, Qwen 3.5 9B (text + vision), explicit context window and per-task sampling |
| Document pipeline  | PDF text extraction, Persian text normalization, page-aware chunking, hybrid OCR |
| Retrieval          | Vector search + cross-encoder reranking (bge-reranker-v2-m3 on llama.cpp, CPU), neighbour expansion, adaptive modes, LLM query rewriting |
| Conversation state | Persistent message history and active-document selection                         |
| Testing            | Vitest unit tests with mocks, DB integration tests, coverage, GitHub Actions CI  |
| Evaluation         | Retrieval, router, end-to-end answer, OCR and latency harnesses                  |
| Deployment         | Docker Compose (PostgreSQL + pgvector)                                           |

## Architecture & Implementation

1. **Document ingestion:** Receive PDFs through Bale, extract text per page, normalize Persian text (Unicode NFKC, tabs, Arabic/Persian letter variants), and detect unreadable pages.
2. **Hybrid OCR:** Only empty, junk or severely broken pages are rendered to images and transcribed by the local vision model; its habit of writing Persian words with reversed letters is detected and repaired; every chunk records whether it came from the text layer or OCR.
3. **Structure-aware chunking:** Detects slide decks vs running text, strips repeated headers and printed page numbers, repairs PDFs that store words in reverse order, sends junk text layers to OCR, and stores slide titles and sections as chunk metadata. Cross-page, semantic (embedding-based topic boundaries) and section-expansion variants are implemented behind switches and were measured against per-page chunking.
4. **Vector storage:** Page-tagged chunks and embeddings are stored in PostgreSQL with pgvector.
5. **Message classification:** An LLM router with a JSON schema picks document retrieval or general conversation, plus the retrieval mode.
6. **Retrieval:** Rewrite follow-ups, search by similarity, add neighbouring chunks, and cite only the pages that were actual hits.
7. **Answer generation:** Grounded prompts with low temperature and an explicit context window; long documents use a map-reduce summary.
8. **Reliability:** Typed errors mapped to friendly messages, background processing, request cancellation, and deduplicated updates.

## Quality & Engineering

### Evaluation (does the AI do the right thing?)

| Harness                | What it measures                                                                                     | Current result (draft sets)                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `npm run eval`         | Retrieval on 92 questions over 7 documents (slides and long notes) by type (exact term, paraphrase, multi-page, follow-up, unanswerable): hit@k, MRR, context coverage, distance and reranker-score calibration, 95% bootstrap intervals, paired diff vs previous run | hit@1 71% → 86% with reranker (95% CI 78–93%), hit@3 98%, answer page in context 98% |
| `npm run eval:router`  | Router accuracy on 30 labelled messages, with a confusion matrix                                     | route 100%, route + mode 97%                   |
| `npm run eval:answers` | Full pipeline: cites the right page, cites inline [n], contains key facts, answers in Persian, refuses unanswerable questions; LLM-as-judge faithfulness | 42/46 pass, inline citations 39/39, 6/6 unanswerable refused (no sources listed), judge faithful 45/46 |
| `npm run eval:ocr`     | OCR character error rate against an automatic answer key (pages with a good text layer)             | prose 5–7% CER                                 |
| `npm run benchmark`    | Time per stage (router, rewrite, retrieval, generation), p50/p95                                     | 10.5 s median, 19.7 s p95; generation 57%, retrieval + rerank 26%, router 16% |
| `npm run feedback`     | Real usage: every answer is logged (question, rewrite, route, pages used, time) with 👍/👎 buttons in Bale; the report shows satisfaction and speed and turns 👎 answers into draft eval questions | — (collects from real use) |

**Found by measuring:** Ollama's default 4096-token context silently truncated long prompts; default sampling (temperature 1.0) was too random for factual answers; every citation was one page off and page 1 was never indexed; the follow-up rewriter sometimes answered instead of rewriting and once replaced a name ("روسو") with a hallucinated one — fixed with a few-shot prompt (follow-ups reaching the right context: 25% → 75%); unanswerable questions have the same vector distances as answerable ones, so the similarity threshold cannot filter them — grounding in the prompt has to (and does); the vision model writes Persian words with reversed letters (~60% CER on slides) — detected and repaired, now 4–14%. OCR on text layers with split letters (12–43% of words, incl. the COVID PDF) gave no gain on 21 questions while costing ~45 s/page, so only worse pages are OCR'd (a 203-page upload: 63 min → 20 s). Hybrid search (PostgreSQL full-text + vectors, Reciprocal Rank Fusion) added no page that vector search had missed on 86 questions — BGE-M3 already handles exact terms and the cross-encoder reranker fixes the order — so it is built but off by default. Speed: Ollama unloaded the model after 5 idle minutes, costing ~10 s on the next question (now kept loaded); general chat was thinking before answering (49 s → 22 s with thinking off); search now runs while the router decides (context ready 7.7 s → 6.0 s). KV-cache quantization was skipped: Qwen 3.5 is a hybrid model whose KV cache is only 256 MB. A chunking ablation on 65 questions over 6 documents (slides and 200-page notes) showed per-page chunks beat cross-page and semantic chunking on long notes (hit@1 50% vs 21% / 36%), because their pages already hold one subtopic each — so those variants stay off by default. Citations: asked to cite numbered sources inline, Qwen did so in 39/39 answers, so the sources list now shows only cited pages; the eval caught a parser bug ("[1][3]" read as [1]) and refusals that still listed sources. A reranker-score cut-off for unanswerable questions was rejected: their scores overlap with correct chunks (the best cut-off kept 84/85 correct chunks but rejected only 2/6 negatives, which the model refuses anyway). Re-ranking the previous answer's pages for follow-ups gave no measurable gain (5/6 in the top 3 either way). Bootstrap intervals showed that an apparent reranker regression on one document (2 of 11 questions) was noise, and that most changes on a 90-question set are within ±5 points. The 203-page notes restate the course in a summary half, so several eval questions needed a second correct page (checked against the PDF text).

### Tests (does the code stay correct?)

- **Unit tests** (`npm test`, 254 tests, < 1 s): pure logic (chunking, normalization, page-quality detection, context merging, citations) plus mocked flows — update deduplication and retry, `/cancel`, the chat pipeline, Ollama timeouts and bad responses, the OCR loop, delete confirmation.
- **Integration tests** (`npm run test:integration`): real PostgreSQL + pgvector with fake embeddings — one user can never search, select or delete another user's documents (verified by deliberately breaking the SQL filter and watching the tests fail), cascade deletes, failed ingestion stores nothing.
- **CI:** GitHub Actions runs type checks (including tests and scripts), unit tests with coverage, and integration tests on every push.
- **Clean layering:** configuration, prompts, user-facing messages, SQL, and platform code each live in one place.

## Technology Stack

`TypeScript` · `Node.js` · `PostgreSQL` · `pgvector` · `BGE-M3` · `Ollama` · `Qwen 3.5 9B` · `llama.cpp` · `bge-reranker-v2-m3` · `Vitest` · `Docker` · `Bale Bot API`

## Project Status

An actively developed personal project exploring retrieval-augmented generation (RAG), local vision-based OCR, context-aware conversations, document retrieval strategies, and LLM-powered study assistance.

## Project structure

```
src/
  main.ts            entry point: health endpoint + Bale polling
  config.ts          all env vars and tunables (models, context size, timeouts, chunking, OCR)
  messages.ts        every user-facing text (Persian)
  logger.ts          leveled logger (LOG_LEVEL=debug|info|warn|error)
  errors.ts          typed errors mapped to user-facing text
  bale.ts            Bale API client (messages, updates, file download)
  bot/               polling loop, update dispatcher, commands
  chat/              message pipeline and PDF upload flow
  llm/               Ollama client (chat, vision, embeddings) and prompts
  rag/               router, ingest, OCR, chunking, retrieval, query rewriting, answers
  db/                one module per table; all SQL lives here
migrations/          node-pg-migrate schema migrations
scripts/             evaluation harnesses, benchmark, data reset, local PDF ingestion
eval/                labelled question sets (results go to eval/results/, not committed)
tests/               unit tests; tests/integration/ runs against a real database
```

## Getting started

```bash
mkdir -p models && curl -L -o models/bge-reranker-v2-m3-Q8_0.gguf https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf
docker compose up -d          # PostgreSQL + pgvector, reranker (CPU)
npm install
npm run migrate:up
ollama pull qwen3.5:9b && ollama pull bge-m3
npm run dev                   # start the bot
npm test                      # unit tests
npm run test:integration      # database tests (creates daneshjohandbot_test)
npm run feedback              # real-usage report: 👍/👎, answer times, 👎 answers as draft eval questions
npm run eval                  # retrieval evaluation (also: eval:router, eval:answers, eval:ocr, benchmark)
```

Configure `.env` with `BALE_TOKEN`, `DATABASE_URL`, `LLM_URL`, `LLM_MODEL`, `EMBEDDING_MODEL`, `PORT`, and the Postgres credentials. Optional: `LLM_KEEP_ALIVE` (how long Ollama keeps models in GPU memory, default `30m`; `-1` = always).
