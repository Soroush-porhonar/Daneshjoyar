# Daneshjoyar — Persian Study Assistant (RAG) for Bale

**Local-first retrieval-augmented generation bot for [Bale](https://bale.ai) Messenger. Students upload PDFs (including scanned ones), ask questions in Persian, and get answers with inline citations and page references.**

`TypeScript` · `Node.js` · `PostgreSQL + pgvector` · `BGE-M3` · `bge-reranker-v2-m3` · `Ollama` · `Qwen 3.5 9B` · `llama.cpp` · `Vitest` · `Docker`

## Screenshots

<p align="center">
  <img src="screenshots/Screenshot_20261025_201501_Bale.jpg" width="18%" alt="Start Screen" />
  <img src="screenshots/Screenshot_20261109_234747_Bale.jpg" width="18%" alt="General Questions" />
  <img src="screenshots/Screenshot_20261109_234518_Bale.jpg" width="18%" alt="Document Support" />
  <img src="screenshots/Screenshot_20261109_234543_Bale.jpg" width="18%" alt="Precise RAG Responses" />
  <img src="screenshots/Screenshot_20261109_234202_Bale.jpg" width="18%" alt="Multiple Document Management" />
</p>

## Results

| Area | Result |
| --- | --- |
| Retrieval — 178 answerable questions, 8 documents, all-documents search | hit@1 **67% → 84%** with reranking (95% CI 79–89), hit@3 **94%**, answer page in context **96%**; with 12 unrelated documents added (20 in all): in context still 96%, top chunks from another document 10 → 12% |
| End-to-end answers — 117 questions | **112 pass**, expected page in context 87/87, citations on topic 97%, unanswerable questions refused **30/30** (near-miss 23/23), wrong refusals 0; cited sentences supported by their sources **241/272 (89%)**, judged by gpt-oss:20b (rough, low estimate: the judge rejects about 1 in 5 supported claims) |
| Router — 62 labelled messages, 24 sent by students | route and route + retrieval mode **100%** (real messages 100%); follow-up decision 29/29, standalone questions after history rewritten 0/20 |
| OCR — scanned handout vs hand-typed reference | character error rate **37.0% → 4.0%** |
| Latency | answers stream into the chat: first text 7.7 s median in the benchmark (stages in sequence; the bot runs router and search in parallel), whole answer 10.6 s median, 11.1 s p95 (router 2.5 s, retrieval + CPU rerank 2.3 s, generation 4.9 s at ~37 tokens/s); router after a long conversation 18.5 → 5.2 s with a trimmed history |
| Whole-document summary | 21–44 s from stored section summaries vs 129 s – 31 min map-reduce |
| Load — 10 students at once | 10/10 answered, none timed out, each told their place in line; longest 94.5 s, 6.3 answers per minute (one GPU) |
| Tests | 818 unit, 48 integration (real Postgres), CI |

## Features

- Upload, list and delete PDFs; questions are answered from **all** of a student's documents at once.
- Grounded answers with numbered inline citations and a list of the cited pages only; refusals list none.
- Scanned and broken PDFs read by a local vision model, with progress updates in the chat.
- Follow-ups ("explain more") understood from the conversation; whole-document summaries.
- Questions about a handout itself ("what is it about", "who wrote it") answered from its stored profile.
- "Shorter", "simpler", "in three sentences" reshape the previous answer from the same sources.
- History older than an hour is ignored; «🆕 موضوع جدید» or `/new` starts a fresh topic.
- Answers appear while they are written (the "thinking" message becomes the answer).
- Buttons for navigation, cancel and 👍/👎 feedback; slow work runs in the background and is cancellable.
- Fair use of the one GPU: questions wait in a queue that tells each student their place; a long scan is confirmed first; one upload at a time and 50 questions a day per student.

## Architecture

```mermaid
flowchart LR
  subgraph Ingest
    A[PDF] --> B[Per-page text and quality check]
    B -->|poor pages| C[Vision OCR: crop, strips, reversed-word repair]
    B --> D[Structure-aware chunking]
    C --> D
    D --> E[BGE-M3 embeddings]
    E --> F[(PostgreSQL + pgvector)]
    F -. background .-> G[Enrichment: title, topics, section summaries, chunk questions]
    G -.-> F
  end
  subgraph Query
    Q[Message] --> R[LLM router, JSON schema]
    Q --> S[Early search]
    R --> W[Follow-up decision + standalone question]
    S --> X[Vector + question index, RRF]
    W --> X
    X --> Y[Cross-encoder rerank]
    Y --> Z[Neighbour expansion]
    Z --> L[Grounded generation, inline citations]
  end
  F --> X
```

## Methods

**Retrieval**
- Dense search over chunks **and** LLM-generated "questions each chunk answers", fused with Reciprocal Rank Fusion: hit@10 96 → 99%, no question worse.
- Cross-encoder reranking (bge-reranker-v2-m3, CPU) of the top 10: hit@1 69 → 88%; falls back to vector order if the service is down.
- Neighbour-chunk expansion; only real hits are cited.
- Router (JSON-schema output) runs in parallel with a speculative search; a clear reranker score overrules a "chat" decision.
- The router decides whether a message depends on the history and writes the standalone question in the same call (follow-up decision 9/29 with the old length rule → 29/29); the previous answer's chunks compete in the rerank.
- Rule-based routes before the router: questions about the document itself, and requests to reshape the previous answer.

**Ingestion and OCR**
- Hybrid extraction: text layer first, vision OCR only for empty / junk / split-letter pages (203-page upload: 63 min → 20 s).
- Phone scans: crop to the text, render at 1400 px, read in strips cut between lines (the vision encoder is quadratic in patches; one large image was 2× slower and crashed the Vulkan driver): CER 37.0 → 4.0%.
- Reversed-Persian-word detection and repair against a word-frequency list built from good text layers: CER 41.5 → 15.5%.
- Structure-aware chunking: slide-deck vs prose detection, repeated headers and page numbers stripped, titles kept as metadata. Per-page chunks beat cross-page / semantic chunking on long notes (hit@1 50% vs 21% / 36%).

**Generation**
- Sources first, question last, so exercise questions inside the notes are not answered.
- Numbered inline citations; only cited pages listed; refusal detection suppresses sources.
- Whole-document summaries from per-section summaries stored at upload (one LLM call); map-reduce for documents not yet enriched.
- Explicit `num_ctx` 8192 (Ollama's default 4096 silently truncated prompts), temperature 0.2, thinking off (chat 49 → 22 s), `keep_alive` to avoid ~10 s reloads; models loaded at startup.
- Streaming: the thinking notice is edited as text arrives, at most every 1.5 s and after 40+ new characters, with citations numbered as in the final answer; a Bale rate limit (429) waits `retry_after` and doubles the interval. `STREAM_MODE=parts` sends 2–3 messages at paragraph ends instead; `off` sends the whole answer at the end.
- Output caps per mode (focused 1000 tokens, multi-part 2000, chat 1000) stop a runaway answer and say so; they sit above every real answer. The router reads the last 6 turns, 600 characters each, without source lists.
- Tried and not kept: a prompt rule to write only sentences that can carry a citation (supported sentences 88.6 → 89.3%, within noise, 2 fewer passes); a shorter-answer prompt (answers were already short, median 532 characters); an answer cache (exact repeats were mostly retries after an unsatisfying answer); fixed replies to greetings without the model (felt artificial next to real answers); content hashes to drop duplicate chunks at upload (none among 2,310 chunks; the search's de-duplication costs nothing measurable, 10–11 ms either way).

**Background enrichment**
- Per document: title, summary, topics; per chunk: the questions it answers, embedded into the question index. One document at a time, yields the single GPU to answers, resumes after a restart.

**Reliability**
- Inbox: every Bale update is stored before its work starts and marked done or failed after; a sweeper retries failed updates and work cut off by a restart (3 attempts), and asks the student to resend a message too old to answer late. Nothing is lost when the bot dies mid-answer.
- Graceful shutdown on SIGTERM: no new updates, 15 s for running answers, the rest handed back to the inbox and answered after the restart.
- Bale client: long polling (Bale holds up to ~25 s), retries after rate limits (`retry_after`), server and network errors with growing delays; a `sendMessage` that timed out is never repeated (it may have been delivered).
- One GPU queue for every model call: answers first (oldest question first), upload OCR next, enrichment only when no question is running; timeouts count from the job's turn; a busy message above 12 questions at once; queue wait, first-text time and generation stored per answer.
- Per-chat cancellation, typed errors mapped to user messages, transactional ingestion, duplicate-upload detection, nightly backups.

## Evaluation

| Harness | Measures |
| --- | --- |
| `npm run eval` | hit@k, MRR, context coverage, wrong-document share, distance and reranker-score calibration; per type (exact term, paraphrase, multi-page, follow-up, standalone question after history, unanswerable), per tag (English, Latin-script Persian, typos, Arabic letters, tables, formulas) and a held-out row; every part of multi-concept questions in context; 95% bootstrap CIs and paired diffs against the previous run |
| `npm run eval:router` | route and mode accuracy per kind of message, confusion matrix, rewrite-rule check; includes messages students really sent, with their history; `--with-search` adds the early-search override |
| `npm run eval:answers` | cited page, expected page in context, wrong refusals, inline citations, key facts (accepted forms, formula-tolerant), language, refusals incl. near-miss questions; `--rescore` re-checks a saved run without the model; `--rescore --judge` has gpt-oss:20b (CPU) check every cited sentence against its sources, fact by fact |
| `npm run eval:citations` | hand-labelled citation pairs: how well a judge separates supported from unsupported claims |
| `npm run eval:ocr` | CER against text layers or hand-typed reference pages, per width / strip / crop / prompt / repair |
| `npm run benchmark` | per-stage latency p50 / p95, output tokens and tokens per second, follow-up and after-history samples; `--concurrency N` measures the queue |
| `npm run feedback` | real-usage report per week (chat share, rewrite share, refusals, time, 👍 share); 👎 answers become draft eval questions and router cases |

Runs are saved to `eval/results/`; the retrieval, router, answer and benchmark harnesses also compare each run with the previous one.

**Negative results (implemented, off by default):**

| Idea | Outcome |
| --- | --- |
| Hybrid keyword search (tsvector + RRF) | No page gained on 86 questions; BGE-M3 handles exact terms |
| Cross-page / semantic chunking, section expansion | Lower hit@1 / no effect |
| Context sentence + title in chunk embeddings | hit@1 85 → 82% |
| Reranker score cut-off for unanswerable questions | Scores overlap (kept 84/85 correct, rejected 2/6 negatives) |
| Document titles in the router prompt | Route unchanged, mode accuracy 97 → 91% |
| OCR of split-letter text layers | No gain on 21 questions at ~45 s/page |
| KV-cache quantisation | Skipped: Qwen 3.5's cache is 256 MB |
| gpt-oss:20b judge asked for a verdict only (low or medium thinking) | 24–25/30 labelled citation pairs right, 4/6 unsupported caught; listing the missing facts first reached 26/30, 5/6 |
| Question normalisation (Arabic letters, zero-width marks) | No rank changed on 178 questions |
| Reranking 16 candidates instead of 10 | No page gained; slower rerank on the CPU |
| Looser candidate cut-off (0.65, 0.7) | One finglish page in, another out; in context 96% either way |
| Per-concept search for "X و Y" questions | Every part in context 15 → 14 of 17 |

## Testing

- **Unit (Vitest, 610):** pure logic (chunking, normalisation, page quality, word repair, context merging, citations) and mocked flows (update retry, cancel, OCR loop, enrichment priority, Ollama timeouts).
- **Integration (39, real Postgres + pgvector):** per-user isolation in search, deletion and the question index — verified by breaking the SQL filter and watching the tests fail; cascade deletes; atomic ingestion and enrichment.
- **CI:** type check (src, tests, scripts), coverage and integration tests on every push.

## Getting started

```bash
mkdir -p models && curl -L -o models/bge-reranker-v2-m3-Q8_0.gguf https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf
docker compose up -d          # PostgreSQL + pgvector, reranker (CPU), nightly backup
npm install
npm run migrate:up
ollama pull qwen3.5:9b && ollama pull bge-m3
npm run dev                   # start the bot
```

```bash
npm test                      # unit tests
npm run test:integration      # database tests (creates daneshjohandbot_test)
npm run eval                  # also: eval:router, eval:answers, eval:ocr, benchmark, feedback
npm run enrich -- --all       # enrich documents uploaded before enrichment existed
npm run ingest -- <chatId> <absolute pdf paths>   # ingest without the bot
```

`.env`: `BALE_TOKEN`, `DATABASE_URL`, `LLM_URL`, `LLM_MODEL`, `EMBEDDING_MODEL`, `PORT`, Postgres credentials. Feature switches, and the measurement behind every default, are in `src/config.ts`. On a machine that serves only the bot, set `LLM_KEEP_ALIVE=-1` to keep the model in GPU memory for good (the default, 30m, frees it on a shared machine). `STREAM_MODE` is `edit` (default), `parts` or `off`. `DAILY_QUESTION_LIMIT` (default 50) sets the questions a student may ask per day.

### Docker

Ollama stays on the host (Docker Desktop cannot pass an AMD GPU to containers); the bot, PostgreSQL, reranker and backup run in Compose and reach Ollama at `host.docker.internal:11434` (set `OLLAMA_HOST=0.0.0.0` on Windows if needed).

```bash
docker compose --profile bot up -d --build
docker compose logs -f bot
```

Stop the bot container before `npm run dev`; two pollers would compete for updates.

### Backup and restore

The `backup` service dumps the database nightly at 03:00 (Tehran time) to `backups/`, keeping 14 days. The original PDFs in `uploads/` are only needed to re-ingest (for example after changing the embedding model).

```bash
docker compose exec -T postgres pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" < backups/daneshjo-YYYY-MM-DD.dump
```

Network connections to the database need the password from `.env` (`scram-sha-256`); only the socket inside the postgres container is trusted (health check, `docker compose exec`). A volume created before this rule (with `POSTGRES_HOST_AUTH_METHOD: trust`) is switched once:

```bash
docker compose exec postgres sh -c 'f=$(psql -U "$POSTGRES_USER" -tAc "show hba_file"); sed -i -E "s/^(host\s+.*)trust\s*$/\1scram-sha-256/" "$f" && psql -U "$POSTGRES_USER" -tAc "select pg_reload_conf()"'
```

## Project structure

```
src/
  main.ts            entry point: health endpoint + Bale polling
  config.ts          env vars and tunables, each with its measurement
  messages.ts        all user-facing text (Persian)
  bot/               polling, dispatcher, commands, buttons, enrichment worker, recovery
  chat/              message pipeline and PDF upload flow
  llm/               Ollama client, prompts, GPU priority
  rag/               router, ingest, OCR, chunking, enrichment, retrieval, reranking, rewrite, answers
  db/                one module per table; all SQL lives here
migrations/          node-pg-migrate schema migrations
scripts/             eval harnesses, benchmark, enrichment backfill, OCR word list, local ingestion
eval/                labelled question sets and OCR reference pages
tests/               unit tests; tests/integration/ runs against a real database
```

## Status

Actively developed personal project on retrieval-augmented generation, local vision OCR, and context-aware conversations for Persian study material.
