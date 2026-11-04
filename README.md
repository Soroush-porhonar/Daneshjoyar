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

- **PDF Management:** Upload, process, list, and delete study documents; no document has to be selected.
- **Document-Grounded Q&A:** Answer questions using passages retrieved from all of the student's PDFs at once, with inline numbered citations ([1], [2]) and a sources list of only the pages the answer cites; refusals list no sources.
- **Scanned & Broken PDFs:** Pages with no text layer, junk text, or severely broken Persian letters are read by a local vision model (hybrid OCR, no page limit), with a time estimate and progress updates in the chat.
- **Intelligent Query Routing:** Classify messages and choose between document-based answers and general chat; when the notes clearly match a message (reranker score), they win even if the router said chat. Summary requests pick the document by name, by its generated title or topics, by where the best hits come from, or the newest upload, and name it in the answer.
- **Adaptive Retrieval:** Focused, multi-part, or broad strategies; hits are expanded with neighbouring chunks for context.
- **Follow-Up Understanding:** Short follow-ups ("explain more") are rewritten into standalone questions using the conversation, and the pages of the previous answer compete with the new search results.
- **Long-Document Summarization:** Enriched documents are summarised in one model call from section summaries stored at upload (20–45 s, instead of 2–30 minutes); others are summarised batch by batch (batches sized to the context window), then combined.
- **Background Enrichment:** After an upload is usable, a background worker gives each document a title, a summary and a topic list, stores per-section summaries, and writes the questions each chunk answers, which are searched alongside the chunks. It pauses while a student is waiting for an answer and resumes after a restart.
- **Non-Blocking & Cancellable:** Slow work runs in the background; `/cancel` stops a running request.
- **Buttons:** A main-menu keyboard, delete buttons under the document list, yes/no delete confirmation and a cancel button while answering; typed commands still work and are shown so they render correctly in right-to-left text.
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
| Document pipeline  | PDF text extraction, Persian text normalization, page-aware chunking, hybrid OCR with reversed-word repair, background enrichment (titles, topics, section summaries, generated questions) |
| Retrieval          | Vector search over chunks and their generated questions (fused with RRF) + cross-encoder reranking (bge-reranker-v2-m3 on llama.cpp, CPU), neighbour expansion, adaptive modes, LLM query rewriting |
| Conversation state | Persistent message history; follow-ups re-rank the previous answer's chunks        |
| Testing            | Vitest unit tests with mocks, DB integration tests, coverage, GitHub Actions CI  |
| Evaluation         | Retrieval, router, end-to-end answer, OCR and latency harnesses                  |
| Deployment         | Docker Compose (bot, PostgreSQL + pgvector, reranker, nightly backup); Ollama on the host GPU |

## Architecture & Implementation

1. **Document ingestion:** Receive PDFs through Bale, extract text per page, normalize Persian text (Unicode NFKC, tabs, Arabic/Persian letter variants), and detect unreadable pages.
2. **Hybrid OCR:** Only empty, junk or severely broken pages are rendered to images and transcribed by the local vision model; its habit of writing Persian words with reversed letters is detected and repaired; every chunk records whether it came from the text layer or OCR.
3. **Structure-aware chunking:** Detects slide decks vs running text, strips repeated headers and printed page numbers, repairs PDFs that store words in reverse order, sends junk text layers to OCR, and stores slide titles and sections as chunk metadata. Cross-page, semantic (embedding-based topic boundaries) and section-expansion variants are implemented behind switches and were measured against per-page chunking.
4. **Vector storage:** Page-tagged chunks and embeddings are stored in PostgreSQL with pgvector.
5. **Enrichment (background):** Per section a stored summary, per document a title, summary and topics (JSON-schema output), per chunk a context sentence (stored; searching by it is off, see below) and 2–3 questions it answers, embedded into a question index. One document at a time, yielding the GPU to answers; about 10 s per chunk on the test machine.
6. **Message classification:** An LLM router with a JSON schema picks document retrieval or general conversation, plus the retrieval mode.
7. **Retrieval:** Rewrite follow-ups, search every chunk of the student's documents by similarity (and the questions stored for enriched chunks), rerank, add neighbouring chunks from the same document, and cite only the pages the answer uses.
8. **Answer generation:** Grounded prompts with low temperature and an explicit context window; summaries use the stored section summaries, or a map-reduce over the document before it is enriched.
9. **Reliability:** Typed errors mapped to friendly messages, background processing, request cancellation, and deduplicated updates.

## Quality & Engineering

### Evaluation (does the AI do the right thing?)

| Harness                | What it measures                                                                                     | Current result (draft sets)                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `npm run eval`         | Retrieval on 100 questions over 8 documents (slides, long notes, a scanned handout), searching all of the student's documents, by type (exact term, paraphrase, multi-page, follow-up, unanswerable): hit@k, MRR, context coverage, share of top chunks from the wrong document, distance and reranker-score calibration, 95% bootstrap intervals, paired diff vs previous run | hit@1 68% → 86% with reranker (95% CI 78–92%), hit@3 96%, answer page in context 96% |
| `npm run eval:router`  | Router accuracy on 33 labelled messages, with a confusion matrix; `--with-search` adds the early search that can overrule "chat" | route 100%, route + mode 97%                   |
| `npm run eval:answers` | Full pipeline: cites the right page, cites inline [n], contains key facts, answers in Persian, refuses unanswerable questions; LLM-as-judge faithfulness | 44/54 pass, inline citations 46/46, 7/7 unanswerable refused (no sources listed), judge faithful 53/54 |
| `npm run eval:ocr`     | OCR character error rate against an automatic answer key (pages with a good text layer) or hand-typed reference pages (`--ref`), per image width, prompt and reversed-word repair | prose 5–7% CER; scanned handout 41.5% → 15.5% with repair |
| `npm run benchmark`    | Time per stage (router, rewrite, retrieval, generation), p50/p95                                     | 10.5 s median, 19.7 s p95; generation 57%, retrieval + rerank 26%, router 16% |
| `npm run feedback`     | Real usage: every answer is logged (question, rewrite, route, pages used, time) with 👍/👎 buttons in Bale; the report shows satisfaction and speed and turns 👎 answers into draft eval questions | — (collects from real use) |

**Found by measuring:** Ollama's default 4096-token context silently truncated long prompts; default sampling (temperature 1.0) was too random for factual answers; every citation was one page off and page 1 was never indexed; the follow-up rewriter sometimes answered instead of rewriting and once replaced a name ("روسو") with a hallucinated one — fixed with a few-shot prompt (follow-ups reaching the right context: 25% → 75%); unanswerable questions have the same vector distances as answerable ones, so the similarity threshold cannot filter them — grounding in the prompt has to (and does); the vision model writes Persian words with reversed letters (~60% CER on slides) — detected and repaired, now 4–14%. OCR on text layers with split letters (12–43% of words, incl. the COVID PDF) gave no gain on 21 questions while costing ~45 s/page, so only worse pages are OCR'd (a 203-page upload: 63 min → 20 s). Hybrid search (PostgreSQL full-text + vectors, Reciprocal Rank Fusion) added no page that vector search had missed on 86 questions — BGE-M3 already handles exact terms and the cross-encoder reranker fixes the order — so it is built but off by default. Speed: Ollama unloaded the model after 5 idle minutes, costing ~10 s on the next question (now kept loaded); general chat was thinking before answering (49 s → 22 s with thinking off); search now runs while the router decides (context ready 7.7 s → 6.0 s). KV-cache quantization was skipped: Qwen 3.5 is a hybrid model whose KV cache is only 256 MB. A chunking ablation on 65 questions over 6 documents (slides and 200-page notes) showed per-page chunks beat cross-page and semantic chunking on long notes (hit@1 50% vs 21% / 36%), because their pages already hold one subtopic each — so those variants stay off by default. Citations: asked to cite numbered sources inline, Qwen did so in 39/39 answers, so the sources list now shows only cited pages; the eval caught a parser bug ("[1][3]" read as [1]) and refusals that still listed sources. A reranker-score cut-off for unanswerable questions was rejected: their scores overlap with correct chunks (the best cut-off kept 84/85 correct chunks but rejected only 2/6 negatives, which the model refuses anyway). Re-ranking the previous answer's pages for follow-ups gave no measurable gain (5/6 in the top 3 either way). Bootstrap intervals showed that an apparent reranker regression on one document (2 of 11 questions) was noise, and that most changes on a 90-question set are within ±5 points. The 203-page notes restate the course in a summary half, so several eval questions needed a second correct page (checked against the PDF text).

**Enrichment and scanned pages, measured:** On a scanned handout with hand-typed reference text (3 pages), OCR at 1000 px with an English prompt had 41.5% character errors before repair; flipping reversed words page by page gave 18.6%, word by word against a word list from good text layers 20.4%, both together 15.5% (what remains is misread letters). 1400 px was twice as slow and crashed the GPU driver. Upload-time enrichment, each part measured on 100 questions over 8 documents with paired bootstrap intervals: searching the questions each chunk answers made no question worse and fixed 4 (3 on the scanned handout, whose OCR text is noisy but whose generated questions are clean), so it is on; embedding chunks with their document title and a context sentence lowered reranked hit@1 (85% → 82%), so it is off; listing document titles and topics for the router changed no route but cost two retrieval-mode decisions (97% → 91%), so the router still sees file names. Summary requests from stored section summaries: 21–44 s on four documents, against 129 s, 380 s, 31 minutes and one timeout for the map-reduce over the same files. A first version asked for a "comprehensive" summary and got the section summaries restated (11k characters, up to the 120 s timeout); asking for about 600 words fixed it.

### Tests (does the code stay correct?)

- **Unit tests** (`npm test`, 504 tests, a few seconds): pure logic (chunking, normalization, page-quality detection, reversed-word repair, context merging, citations) plus mocked flows — update deduplication and retry, `/cancel`, the chat pipeline, Ollama timeouts and bad responses, the OCR loop, enrichment and its GPU priority, delete confirmation.
- **Integration tests** (`npm run test:integration`): real PostgreSQL + pgvector with fake embeddings — one user can never search or delete another user's documents or match their stored questions (verified by deliberately breaking the SQL filter and watching the tests fail), cascade deletes, failed ingestion stores nothing, enrichment is saved atomically and resumes after a restart.
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
  config.ts          all env vars and tunables (models, context size, timeouts, chunking, OCR, enrichment)
  messages.ts        every user-facing text (Persian)
  logger.ts          leveled logger (LOG_LEVEL=debug|info|warn|error)
  errors.ts          typed errors mapped to user-facing text
  bale.ts            Bale API client (messages, updates, file download)
  bot/               polling loop, update dispatcher, commands, buttons, enrichment worker, startup recovery
  chat/              message pipeline and PDF upload flow
  llm/               Ollama client (chat, vision, embeddings), prompts, GPU priority for answers
  rag/               router, ingest, OCR, chunking, enrichment, retrieval, reranking, query rewriting, answers
  db/                one module per table; all SQL lives here
migrations/          node-pg-migrate schema migrations
scripts/             evaluation harnesses, benchmark, enrichment backfill, OCR word list, data reset, local PDF ingestion
eval/                labelled question sets and OCR reference pages (results go to eval/results/, not committed)
tests/               unit tests; tests/integration/ runs against a real database
```

## Getting started

```bash
mkdir -p models && curl -L -o models/bge-reranker-v2-m3-Q8_0.gguf https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf
docker compose up -d          # PostgreSQL + pgvector, reranker (CPU), nightly backup
npm install
npm run migrate:up
ollama pull qwen3.5:9b && ollama pull bge-m3
npm run dev                   # start the bot
npm test                      # unit tests
npm run test:integration      # database tests (creates daneshjohandbot_test)
npm run feedback              # real-usage report: 👍/👎, answer times, 👎 answers as draft eval questions
npm run eval                  # retrieval evaluation (also: eval:router, eval:answers, eval:ocr, benchmark)
npm run enrich -- --all       # enrich documents uploaded before enrichment existed (--user <id>, --doc <id>, --force)
npm run build:words           # rebuild the word list the OCR repair uses, from good text layers in the database
npm run ingest -- <chatId> <absolute pdf paths>   # ingest PDFs without the bot (e.g. a separate eval user)
```

Configure `.env` with `BALE_TOKEN`, `DATABASE_URL`, `LLM_URL`, `LLM_MODEL`, `EMBEDDING_MODEL`, `PORT`, and the Postgres credentials. Optional: `LLM_KEEP_ALIVE` (how long Ollama keeps models in GPU memory, default `30m`; `-1` = always), `ENRICHMENT=false` (don't queue new uploads for enrichment), `QUESTION_INDEX=false`, `CHUNK_CONTEXT=true`, and the OCR settings `OCR_IMAGE_WIDTH`, `OCR_PROMPT=en|fa`, `OCR_REPAIR=page|word|both` (defaults and the measurements behind them are in `src/config.ts`).

## Run with Docker

Ollama stays on the host, because Docker Desktop can't give containers an AMD GPU. Everything else runs in Docker: the bot, PostgreSQL, the reranker and the nightly backup. The bot reaches Ollama at `host.docker.internal:11434`, and gets the database and reranker addresses from `compose.yaml` (`.env` keeps the `localhost` ones for `npm run dev`).

```bash
docker compose --profile bot up -d --build   # bot + PostgreSQL + reranker + backup; restarts on crash
docker compose logs -f bot
docker compose --profile bot stop bot        # stop it before `npm run dev` (two bots would compete for updates)
```

The bot only runs with the `bot` profile, so a plain `docker compose up -d` still starts just the services that `npm run dev` needs. If the container can't reach Ollama, set the Windows environment variable `OLLAMA_HOST=0.0.0.0` and restart Ollama. Ollama is then reachable from the local network on port 11434 unless the firewall blocks it. If an upload is interrupted by a crash or restart, its user is asked to send the file again when the bot starts. New uploads are enriched in the background by the bot itself; documents uploaded before enrichment existed are enriched with `npm run enrich -- --all` from the host (about 10 s per chunk on the GPU, so a 250-chunk document takes ~45 minutes; the bot's answers are slower while it runs).

## Backup and restore

The `backup` service in `compose.yaml` dumps the database every night at 03:00 (Tehran time) to `backups/daneshjo-YYYY-MM-DD.dump` and deletes dumps older than 14 days. The database holds everything the bot needs: users, conversations, extracted text, chunks and embeddings, answer logs. The original PDFs in `uploads/` are only needed to re-ingest documents (for example after changing the embedding model), so copy that folder with your normal file backups.

```bash
docker compose logs backup                       # "backup written: ..." each night
docker compose exec backup sh -c 'pg_dump -Fc -f /backups/manual.dump'   # a backup right now

# Restore (stop the bot first; replaces the current data)
docker compose exec -T postgres pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" < backups/daneshjo-2026-11-02.dump
```
