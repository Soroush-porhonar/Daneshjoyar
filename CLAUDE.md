# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Daneshjoyar: a Persian study-assistant bot for the **Bale** messenger (Telegram-like Bot API at `tapi.bale.ai`). Students upload PDFs; questions are answered from them with RAG (retrieval-augmented generation) and page citations. Everything runs locally: Ollama (Qwen 3.5 9B for chat/vision, BGE-M3 for embeddings), PostgreSQL + pgvector, and a llama.cpp reranker container. TypeScript on Node, run directly with `tsx` (no build step).

## Commands

```bash
docker compose up -d            # Postgres+pgvector (host port 5433) and the reranker (port 8081)
npm run migrate:up              # node-pg-migrate, migrations/*.ts
npm run dev                     # bot with watch (tsx watch src/main.ts); npm start without watch
npm run typecheck               # tsc -p tsconfig.check.json (src + tests + scripts; tsconfig.json covers src only)
npm test                        # unit tests (Vitest), no services needed
npx vitest run tests/chunk.test.ts            # one file
npx vitest run tests/chunk.test.ts -t "name"  # one test by name
npm run test:integration        # real Postgres; creates/migrates daneshjohandbot_test (refuses DB names not ending in _test)
npm run test:coverage
```

Evaluation scripts need Ollama + DB (+ reranker) running and use the documents in the DB (newest document per filename; `--doc "<file>=<id>"` pins one; `--only <id-substring>` filters questions):

```bash
npm run eval            # retrieval: hit@k, MRR, hybrid/rerank columns, context coverage, threshold calibration; saves eval/results/ (git-ignored) and diffs vs previous run
npm run eval:router     # router accuracy + confusion matrix (eval/router.json)
npm run eval:answers    # end-to-end answers: citations, mustInclude keywords, refusals on negatives, LLM-as-judge (--no-judge)
npm run eval:ocr -- uploads/x.pdf --pages 2,5   # OCR CER against the page's text layer
npm run benchmark       # latency per stage (p50/p95)
npm run feedback        # real-usage report from answer_logs; writes eval/feedback-candidates.json from 👎 answers
npm run ingest -- <chatId> <absolute pdf paths>  # ingest without the bot (records no file size, so re-ingesting is allowed)
npm run reset-data      # truncates documents/chunks/messages/conversations
```

CI (`.github/workflows/ci.yml`): typecheck, `test:coverage`, `test:integration` against a pgvector service container.

Env (`.env`): `BALE_TOKEN`, `DATABASE_URL`, `LLM_URL`, `LLM_MODEL`, `EMBEDDING_MODEL`, `PORT`, Postgres credentials. Feature switches are env vars read in `src/config.ts` (e.g. `OCR_ENABLED`, `OCR_MAX_PAGES`, `RERANKER_ENABLED`, `HYBRID_SEARCH`, `SECTION_EXPANSION`, `CHUNK_*`, `LLM_KEEP_ALIVE`). The reranker model file must exist at `models/bge-reranker-v2-m3-Q8_0.gguf` (download command in README).

## Architecture (request flow)

- **Polling → dispatch** (`src/bot/poller.ts`, `src/bot/dispatcher.ts`): long-polls `getUpdates`. Updates are deduplicated in `processed_updates` and marked processed **only after the handler succeeds** (handlers return `false` to request a retry). Slow work (answers, PDF ingestion) runs in the background so polling isn't blocked; one `AbortController` per chat (`src/bot/cancellation.ts`) — a new message or `/cancel`/⏹️ aborts the previous request. `callback_query` (button presses) goes to `src/bot/callbacks.ts`.
- **Messages** (`src/chat/chatService.ts`): save user message → command (`src/bot/commands/`, `parseCommand` also maps main-menu button labels and strips direction marks) or `answerQuestion`. Answering: the LLM **router** (`src/rag/router.ts`, JSON-schema output: `document|chat` + `focused|multi_part|broad`) runs **in parallel with a prefetch search** for standalone questions; short follow-ups are first rewritten to standalone questions (`src/rag/rewrite.ts`). Every answer is logged to `answer_logs` and sent with 👍/👎 buttons.
- **Retrieval** (`src/rag/retrieve.ts`): restricted to the user's **active (selected) document**. Vector search (pgvector cosine, cutoff `maxCosineDistance` 0.6) → optional hybrid keyword search fused with RRF (off by default) → **cross-encoder rerank** of the top 10 (`src/rag/rerank.ts`, llama.cpp `/v1/rerank`; falls back to vector order if down) → top 3/5 hits + ±1 neighbour chunks (`mergeContext`). Only real hits are cited as sources.
- **Answering** (`src/rag/answer.ts`, prompts in `src/llm/prompts/`): focused/multi-part = one grounded call; broad = map-reduce over batches of the whole document. In the RAG prompt the **sources come first and the student's question last** (notes contain exercise questions the model would otherwise answer).
- **Ingestion** (`src/chat/documentUpload.ts` → `src/rag/ingest.ts`): duplicate check (same user + filename + size, failed uploads excluded; also a unique index) → per-page text via pdf-parse (`src/rag/pdf.ts`) → page quality check (`assessPage` in `src/rag/textQuality.ts`: empty / junk / >50% split letters) → OCR only for poor pages with the Qwen vision model (`src/rag/ocr.ts`; output with reversed Persian letters is detected and repaired) → structure-aware chunking (`src/rag/chunk.ts`, `structure.ts`: repeated headers/page numbers stripped, slide titles/sections as metadata; per-page chunks by default) → BGE-M3 embeddings → chunks + `content_tsv` (generated full-text column) in `document_chunks` → document becomes active.
- **LLM client** (`src/llm/ollamaClient.ts`): always sends `num_ctx` 8192 (Ollama's default 4096 silently truncates) and `keep_alive`; typed errors (`src/errors.ts`) map to user messages.

## Conventions that matter

- **All user-facing text lives in `src/messages.ts`**: Persian, informal «تو» voice. Commands shown to users must be wrapped with `cmd()` (adds U+200E marks so "/select 3" doesn't render as "3 /select" in RTL text). `tests/messages.test.ts` enforces Persian-only text, no formal endings, and the `cmd()` rule for every exported message.
- **Buttons**: inline-button callback formats and builders are in `src/bot/buttons.ts` (`fb:<log>:<±1>`, `info|sel|del:<docId>`, `delok`, `delno`, `docs`, `cancel`; ≤ 64 bytes). Bale requires `answerCallbackQuery` for every press. Bale splits a button row's width equally (document name gets its own row). The bottom menu keyboard uses only the `keyboard` field (Bale documents nothing else).
- **User isolation** is enforced in SQL (`user_id` filters in `src/db/*` and `retrieve.ts`); integration tests cover it.
- **Tunables live in `src/config.ts`** with comments citing the measurement behind each value. Several features are implemented but **off by default because the evals showed no gain** (hybrid search, cross-page and semantic chunking, section expansion) — re-measure with the eval scripts before turning them on or changing thresholds; new eval questions go in `eval/questions.json` (types: exact_term, paraphrase, multi_page, follow_up, negative).
- The GPU (AMD, 8 GB VRAM, Vulkan) is nearly full with Qwen + BGE-M3; a larger `num_ctx` or extra models push Qwen partly onto the CPU (measured slowdown). The reranker runs on the CPU.
- Tests mock modules with `vi.mock` before importing the subject (`await import(...)`), and the unit-test env disables the reranker (`vitest.config.ts`).
