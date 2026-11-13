/**
 * Integration tests: the real SQL against a real PostgreSQL + pgvector.
 * Only the embedding model is faked, with vectors we control:
 * text containing "#3" is embedded as a unit vector on axis 3, so chunks on
 * the same axis have distance 0 and chunks on other axes have distance 1.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const DIMENSIONS = 1024;

function axis(index: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

const axisOf = (text: string) => Number(/#(\d+)/.exec(text)?.[1] ?? 0);

vi.mock("../../src/rag/embeddings.js", () => ({
  generateEmbedding: vi.fn(async (text: string) => axis(axisOf(text))),
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map((t) => axis(axisOf(t)))),
}));
vi.mock("../../src/rag/pdf.js", () => ({ openPdf: vi.fn() }));

const { pool } = await import("../../src/db/pool.js");
const { findOrCreateUser } = await import("../../src/db/users.js");
const { findOrCreateConversation, startNewTopic } = await import("../../src/db/conversations.js");
const { getRecentMessages } = await import("../../src/db/messages.js");
const {
  deleteDocument,
  failInterruptedDocuments,
  findDocumentFilename,
  findDuplicateDocument,
  getDocumentProfile,
  listCompletedDocuments,
  listCompletedFilenames,
} = await import(
  "../../src/db/documents.js"
);
const { receiveUpdate, finishUpdate, listUnfinishedUpdates, claimRetry, abandonUpdate, hasLaterMessage } = await import(
  "../../src/db/updates.js"
);
const { createAnswerLog, getLastAnswerHits, setFeedback } = await import("../../src/db/answerLogs.js");
const { getChunksByRef, getDocumentChunks, retrieveContext, retrieveRelevantChunks, searchCandidates } = await import(
  "../../src/rag/retrieve.js"
);
const {
  claimPendingDocument,
  getSectionSummaries,
  resetRunningEnrichment,
  saveEnrichment,
  setEnrichmentStatus,
} = await import("../../src/db/enrichment.js");
const { ingestDocument } = await import("../../src/rag/ingest.js");
const { config } = await import("../../src/config.js");
const { DuplicateDocumentError } = await import("../../src/errors.js");
const { openPdf } = await import("../../src/rag/pdf.js");
const { generateEmbeddings } = await import("../../src/rag/embeddings.js");

// --- Fixtures -------------------------------------------------------------------

async function addUser(chatId: string): Promise<number> {
  const user = await findOrCreateUser(chatId);
  await findOrCreateConversation(user.id);
  return user.id;
}

/** Adds a document whose chunk i lies on axes[i] and is on page i + 1. */
async function addDocument(
  userId: number,
  filename: string,
  axes: number[],
  status = "completed",
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO documents (user_id, filename, status) VALUES ($1, $2, $3) RETURNING id`,
    [userId, filename, status],
  );
  const documentId = result.rows[0]!.id;

  for (const [index, axisIndex] of axes.entries()) {
    await pool.query(
      `INSERT INTO document_chunks
         (document_id, chunk_index, page_number, content, embedding, extraction_method)
       VALUES ($1, $2, $3, $4, $5::vector, 'text')`,
      [documentId, index, index + 1, `${filename} chunk ${index}`, `[${axis(axisIndex).join(",")}]`],
    );
  }

  return documentId;
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE users, conversations, messages, documents, document_chunks, processed_updates
     RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});

// --- Tests ----------------------------------------------------------------------

describe("user isolation (one student must never see another's documents)", () => {
  it("search only returns the asking user's chunks", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    await addDocument(alice, "alice.pdf", [1]);
    await addDocument(bob, "bob.pdf", [1]);

    const hits = await retrieveRelevantChunks(alice, "question #1", 10);

    expect(hits.map((hit) => hit.filename)).toEqual(["alice.pdf"]);
  });

  it("search inside another user's document returns nothing", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const bobsDocument = await addDocument(bob, "bob.pdf", [1]);

    await expect(retrieveRelevantChunks(alice, "#1", 10, bobsDocument)).resolves.toEqual([]);
    await expect(getDocumentChunks(alice, bobsDocument)).rejects.toThrow();
  });

  it("cannot see or delete another user's document", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const bobsDocument = await addDocument(bob, "bob.pdf", [1]);

    expect(await findDocumentFilename(alice, bobsDocument)).toBeNull();
    expect(await deleteDocument(alice, bobsDocument)).toBe(false);
    expect(await findDocumentFilename(bob, bobsDocument)).toBe("bob.pdf");
  });

  it("cannot load another user's chunks by position (reshaping a previous answer)", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const alicesDocument = await addDocument(alice, "alice.pdf", [1, 2]);
    const bobsDocument = await addDocument(bob, "bob.pdf", [1]);

    const chunks = await getChunksByRef(alice, [
      { documentId: alicesDocument, chunkIndex: 1 },
      { documentId: bobsDocument, chunkIndex: 0 },
      { documentId: alicesDocument, chunkIndex: 0 },
    ]);

    expect(chunks.map((chunk) => [chunk.filename, chunk.chunkIndex, chunk.isHit])).toEqual([
      ["alice.pdf", 1, true],
      ["alice.pdf", 0, true],
    ]);
  });

  it("cannot read another user's document profile (questions about a document itself)", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const bobsDocument = await addDocument(bob, "bob.pdf", [1]);
    await pool.query(`UPDATE documents SET title = 'جزوه باب', summary = 'خلاصه', topics = '{پشته}' WHERE id = $1`, [
      bobsDocument,
    ]);

    expect(await getDocumentProfile(alice, bobsDocument)).toBeNull();
    expect(await getDocumentProfile(bob, bobsDocument)).toEqual({ title: "جزوه باب", summary: "خلاصه", topics: ["پشته"] });
  });
});

describe("documents", () => {
  it("lists only completed documents of the user", async () => {
    const alice = await addUser("alice");
    await addDocument(alice, "ready.pdf", [1]);
    await addDocument(alice, "broken.pdf", [], "failed");
    await addDocument(alice, "busy.pdf", [], "processing");

    expect(await listCompletedFilenames(alice)).toEqual(["ready.pdf"]);
  });

  it("names an enriched photo by its title too (its file name says nothing), a PDF by its name only", async () => {
    const alice = await addUser("alice");
    const photo = await addDocument(alice, "capture_123.jpg", [1]);
    const pdf = await addDocument(alice, "notes.pdf", [2]);
    await addDocument(alice, "photo-2026-11-04.png", [3]);
    await pool.query(`UPDATE documents SET title = 'معیارهای ارزیابی رگرسیون' WHERE id = ANY($1)`, [[photo, pdf]]);

    expect((await listCompletedFilenames(alice)).sort()).toEqual([
      "capture_123.jpg (معیارهای ارزیابی رگرسیون)",
      "notes.pdf",
      "photo-2026-11-04.png",
    ]);
  });

  it("lists the user's ready documents newest first, for picking what to summarise", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const older = await addDocument(alice, "older.pdf", [1]);
    await addDocument(alice, "broken.pdf", [], "failed");
    const newer = await addDocument(alice, "newer.pdf", [2]);
    await addDocument(bob, "bob.pdf", [3]);

    expect(await listCompletedDocuments(alice)).toEqual([
      { id: newer, filename: "newer.pdf", title: null, topics: null },
      { id: older, filename: "older.pdf", title: null, topics: null },
    ]);
  });

  it("deleting a document also deletes its chunks", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [1, 2, 3]);

    expect(await deleteDocument(alice, documentId)).toBe(true);

    const left = await pool.query("SELECT 1 FROM document_chunks WHERE document_id = $1", [
      documentId,
    ]);
    expect(left.rowCount).toBe(0);
  });
});

describe("retrieval", () => {
  it("ranks by distance and drops chunks above the threshold", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [1, 2, 1]);

    const hits = await retrieveRelevantChunks(alice, "#1", 10, documentId);

    // Chunks 0 and 2 match exactly; chunk 1 (distance 1) is over the cutoff.
    expect(hits.map((hit) => hit.chunkIndex).sort()).toEqual([0, 2]);
    expect(hits.every((hit) => Number(hit.distance) < 0.01)).toBe(true);
  });

  it("a looser threshold (used by the eval) returns far chunks too", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [1, 2]);

    const hits = await retrieveRelevantChunks(alice, "#1", 10, documentId, 2);

    expect(hits).toHaveLength(2);
    expect(hits[0]!.chunkIndex).toBe(0);
  });

  it("adds the chunks before and after a hit as context", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [5, 6, 1, 7, 8]);

    const context = await retrieveContext(alice, "#1", "focused", { documentId });

    expect(context.map((chunk) => chunk.chunkIndex)).toEqual([1, 2, 3]);
    expect(context.map((chunk) => chunk.isHit)).toEqual([false, true, false]);
  });

  it("adds the whole section of a slide hit (same title), within the cap", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "slides.pdf", [5, 6, 1, 7, 8, 9]);
    // Slides 1-4 share one title (section 0); 0 and 5 are other sections.
    await pool.query(
      `UPDATE document_chunks SET section_index =
         CASE WHEN chunk_index BETWEEN 1 AND 4 THEN 0 ELSE chunk_index + 10 END
       WHERE document_id = $1`,
      [documentId],
    );

    const context = await retrieveContext(alice, "#1", "focused", { documentId });

    // Hit 2, its neighbours 1 and 3, and the rest of its section (4); not other sections.
    expect(context.map((chunk) => chunk.chunkIndex)).toEqual([1, 2, 3, 4]);
  });

  it("hybrid search finds an exact term that vector search misses", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [5, 6, 7]);
    // Chunk 2 mentions the term; its vector is far from the question's (#1).
    await pool.query(
      `UPDATE document_chunks SET content = 'استاندارد ISO 29119 برای فرایند تست'
       WHERE document_id = $1 AND chunk_index = 2`,
      [documentId],
    );

    const vectorOnly = await retrieveRelevantChunks(alice, "#1 29119", 10, documentId);
    const hybrid = await searchCandidates(alice, "#1 29119", 10, documentId);

    expect(vectorOnly).toEqual([]);
    expect(hybrid.map((chunk) => chunk.chunkIndex)).toEqual([2]);
  });

  it("keyword search respects user isolation", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const bobsDocument = await addDocument(bob, "bob.pdf", [5]);
    await pool.query(
      `UPDATE document_chunks SET content = 'استاندارد 29119' WHERE document_id = $1`,
      [bobsDocument],
    );

    await expect(searchCandidates(alice, "#1 29119", 10)).resolves.toEqual([]);
  });

  it("returns no context when nothing is close enough", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [5, 6]);

    await expect(retrieveContext(alice, "#1", "focused", { documentId })).resolves.toEqual([]);
  });
});

describe("ingestDocument", () => {
  const page = (pageNumber: number, marker: string) => ({
    pageNumber,
    method: "text" as const,
    text: `این متن صفحه ${pageNumber} از جزوه آزمایشی است و به اندازه کافی طولانی است ${marker}`,
  });

  it("stores page-tagged chunks and completes the document", async () => {
    const alice = await addUser("alice");
    vi.mocked(openPdf).mockResolvedValue({
      pages: [page(1, "#1"), page(2, "#2")],
      renderPage: vi.fn(),
      close: vi.fn(async () => {}),
    });

    const result = await ingestDocument(alice, "notes.pdf", "ignored.pdf");

    expect(result).toMatchObject({ pageCount: 2, ocrPages: 0 });
    expect(await listCompletedFilenames(alice)).toEqual(["notes.pdf"]);

    const hits = await retrieveRelevantChunks(alice, "#2", 10);
    expect(hits.map((hit) => hit.pageNumber)).toEqual([2]);

    const stored = await pool.query(
      `SELECT page_number, page_end, section_title, section_index
       FROM document_chunks ORDER BY chunk_index`,
    );
    expect(stored.rows).toEqual([
      { page_number: 1, page_end: 1, section_title: page(1, "#1").text, section_index: 0 },
      { page_number: 2, page_end: 2, section_title: page(2, "#2").text, section_index: 1 },
    ]);
  });

  it("marks the document failed and stores nothing when embedding fails", async () => {
    const alice = await addUser("alice");
    vi.mocked(openPdf).mockResolvedValue({
      pages: [page(1, "#1")],
      renderPage: vi.fn(),
      close: vi.fn(async () => {}),
    });
    vi.mocked(generateEmbeddings).mockRejectedValueOnce(new Error("ollama down"));

    await expect(ingestDocument(alice, "notes.pdf", "ignored.pdf")).rejects.toThrow("ollama down");

    const documents = await pool.query<{ status: string }>("SELECT status FROM documents");
    expect(documents.rows).toEqual([{ status: "failed" }]);
    const chunks = await pool.query("SELECT 1 FROM document_chunks");
    expect(chunks.rowCount).toBe(0);
  });
});

describe("duplicate uploads (same user, same name and size)", () => {
  const pages = [
    {
      pageNumber: 1,
      method: "text" as const,
      text: "این متن صفحه اول از جزوه آزمایشی است و به اندازه کافی طولانی است #1",
    },
  ];

  beforeEach(() => {
    vi.mocked(openPdf).mockResolvedValue({ pages, renderPage: vi.fn(), close: vi.fn(async () => {}) });
  });

  it("finds the user's existing copy, but not another user's or a different size", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const { documentId } = await ingestDocument(alice, "notes.pdf", "x.pdf", undefined, 1234);

    expect(await findDuplicateDocument(alice, "notes.pdf", 1234)).toEqual({ id: documentId, status: "completed" });
    expect(await findDuplicateDocument(bob, "notes.pdf", 1234)).toBeNull();
    expect(await findDuplicateDocument(alice, "notes.pdf", 999)).toBeNull();
  });

  it("the database refuses a second copy, even if the check was skipped", async () => {
    const alice = await addUser("alice");
    await ingestDocument(alice, "notes.pdf", "x.pdf", undefined, 1234);

    await expect(ingestDocument(alice, "notes.pdf", "x.pdf", undefined, 1234)).rejects.toBeInstanceOf(
      DuplicateDocumentError,
    );
  });

  it("a failed upload does not block sending the file again", async () => {
    const alice = await addUser("alice");
    vi.mocked(generateEmbeddings).mockRejectedValueOnce(new Error("ollama down"));
    await expect(ingestDocument(alice, "notes.pdf", "x.pdf", undefined, 1234)).rejects.toThrow();

    expect(await findDuplicateDocument(alice, "notes.pdf", 1234)).toBeNull();
    await expect(ingestDocument(alice, "notes.pdf", "x.pdf", undefined, 1234)).resolves.toBeTruthy();
  });

  it("scripts that re-ingest on purpose (no size) are not blocked", async () => {
    const alice = await addUser("alice");
    await ingestDocument(alice, "notes.pdf", "x.pdf");

    await expect(ingestDocument(alice, "notes.pdf", "x.pdf")).resolves.toBeTruthy();
  });
});

describe("uploads interrupted by a crash or restart", () => {
  it("marks uploads left 'processing' as failed and says whose they were", async () => {
    const alice = await addUser("alice");
    const stuck = await addDocument(alice, "stuck.pdf", [1], "processing");
    const done = await addDocument(alice, "done.pdf", [2]);

    expect(await failInterruptedDocuments()).toEqual([{ chatId: "alice", filename: "stuck.pdf" }]);

    const statuses = await pool.query<{ id: number; status: string }>(
      "SELECT id, status FROM documents ORDER BY id",
    );
    expect(statuses.rows).toEqual([
      { id: stuck, status: "failed" },
      { id: done, status: "completed" },
    ]);
    expect(await failInterruptedDocuments()).toEqual([]);
  });

  it("the interrupted file can be sent again afterwards", async () => {
    const alice = await addUser("alice");
    await pool.query(
      `INSERT INTO documents (user_id, filename, status, file_size) VALUES ($1, 'notes.pdf', 'processing', 1234)`,
      [alice],
    );
    expect(await findDuplicateDocument(alice, "notes.pdf", 1234)).not.toBeNull();

    await failInterruptedDocuments();

    expect(await findDuplicateDocument(alice, "notes.pdf", 1234)).toBeNull();
    // The unique index no longer counts it either.
    await expect(
      pool.query(
        `INSERT INTO documents (user_id, filename, status, file_size) VALUES ($1, 'notes.pdf', 'processing', 1234)`,
        [alice],
      ),
    ).resolves.toBeTruthy();
  });
});

describe("answer logs and feedback", () => {
  const log = (userId: number) => ({
    userId,
    question: "پریم چیه؟",
    rewrittenQuestion: null,
    route: "document" as const,
    retrievalMode: "focused",
    documentIds: [] as number[],
    context: [{ page: 14, chunkIndex: 13, isHit: true }],
    answer: "جواب",
    latencyMs: 9000,
  });

  it("stores an answer and the user's vote on it", async () => {
    const alice = await addUser("alice");
    const id = await createAnswerLog(log(alice));

    expect(await setFeedback(id, alice, -1)).toBe(true);

    const row = await pool.query("SELECT feedback, context FROM answer_logs WHERE id = $1", [id]);
    expect(row.rows[0]).toEqual({ feedback: -1, context: [{ page: 14, chunkIndex: 13, isHit: true }] });
  });

  it("nobody can vote on someone else's answer", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const id = await createAnswerLog(log(alice));

    expect(await setFeedback(id, bob, 1)).toBe(false);

    const row = await pool.query("SELECT feedback FROM answer_logs WHERE id = $1", [id]);
    expect(row.rows[0].feedback).toBeNull();
  });

  it("returns the hits of the user's latest answer when it came from a document", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [1, 2]);
    await createAnswerLog({
      ...log(alice),
      documentIds: [documentId],
      context: [
        { documentId, page: 1, chunkIndex: 0, isHit: false },
        { documentId, page: 2, chunkIndex: 1, isHit: true },
      ],
    });

    expect(await getLastAnswerHits(alice)).toEqual([{ documentId, chunkIndex: 1 }]);

    // A later chat answer means the next message is not a follow-up on those pages.
    await createAnswerLog({ ...log(alice), route: "chat", retrievalMode: null, context: [] });

    expect(await getLastAnswerHits(alice)).toEqual([]);
  });

  it("reads each hit's own document, and the answer's document in older rows", async () => {
    const alice = await addUser("alice");
    const first = await addDocument(alice, "a.pdf", [1]);
    const second = await addDocument(alice, "b.pdf", [2]);
    const id = await createAnswerLog({
      ...log(alice),
      documentIds: [first, second],
      context: [
        { documentId: second, page: 1, chunkIndex: 0, isHit: true },
        { page: 4, chunkIndex: 3, isHit: true }, // logged before chunks named their document
      ],
    });
    // Rows from that time named their one document in document_id.
    await pool.query("UPDATE answer_logs SET document_id = $2 WHERE id = $1", [id, first]);

    expect(await getLastAnswerHits(alice)).toEqual([
      { documentId: second, chunkIndex: 0 },
      { documentId: first, chunkIndex: 3 },
    ]);
  });
});

describe("follow-ups: the previous answer's chunks as candidates", () => {
  it("adds the included chunks after the search hits", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [1, 5, 6]);

    const candidates = await searchCandidates(alice, "#1", 10, documentId, undefined, [
      { documentId, chunkIndex: 2 },
      { documentId, chunkIndex: 0 },
    ]);

    // Chunk 2 is far from the question but still a candidate; chunk 0 is not repeated.
    expect(candidates.map((chunk) => chunk.chunkIndex)).toEqual([0, 2]);
  });

  it("never includes chunks of another user's document", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const bobsDocument = await addDocument(bob, "bob.pdf", [5, 6]);

    await expect(
      searchCandidates(alice, "#1", 10, undefined, undefined, [
        { documentId: bobsDocument, chunkIndex: 0 },
        { documentId: bobsDocument, chunkIndex: 1 },
      ]),
    ).resolves.toEqual([]);
  });

  it("searches all the user's documents and keeps each chunk's neighbours in its own document", async () => {
    const alice = await addUser("alice");
    const first = await addDocument(alice, "a.pdf", [5, 1, 6]);
    const second = await addDocument(alice, "b.pdf", [7, 1, 8]);

    const context = await retrieveContext(alice, "#1", "focused");

    // Both documents' chunk 1 match; each brings its own chunks 0 and 2, never the other file's.
    expect(context.map((chunk) => [chunk.filename, chunk.chunkIndex, chunk.isHit])).toEqual([
      ["a.pdf", 0, false],
      ["a.pdf", 1, true],
      ["a.pdf", 2, false],
      ["b.pdf", 0, false],
      ["b.pdf", 1, true],
    ]);
    expect(new Set(context.map((chunk) => chunk.documentId))).toEqual(new Set([first, second]));
  });

  it("never searches another user's documents", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    await addDocument(bob, "bob.pdf", [1]);

    await expect(retrieveContext(alice, "#1", "focused")).resolves.toEqual([]);
  });
});

describe("conversation history (what the models see of earlier turns)", () => {
  async function addMessage(conversationId: number, role: "user" | "assistant", content: string, minutesAgo = 0) {
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, NOW() - make_interval(mins => $4))`,
      [conversationId, role, content, minutesAgo],
    );
  }

  it("leaves out turns older than the age limit", async () => {
    const alice = await addUser("alice");
    const conversation = await findOrCreateConversation(alice);
    await addMessage(conversation, "user", "سؤال دیروز", 24 * 60);
    await addMessage(conversation, "assistant", "جواب دیروز", 24 * 60);
    await addMessage(conversation, "user", "سؤال الان");

    expect(await getRecentMessages(conversation, 10, 60)).toEqual([{ role: "user", content: "سؤال الان" }]);
  });

  it("starts afresh after a new topic, only in that student's conversation", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const alices = await findOrCreateConversation(alice);
    const bobs = await findOrCreateConversation(bob);
    await addMessage(alices, "user", "قبلی آلیس", 1);
    await addMessage(bobs, "user", "قبلی باب", 1);

    await startNewTopic(alices);
    await addMessage(alices, "user", "تازه");

    expect((await getRecentMessages(alices)).map((m) => m.content)).toEqual(["تازه"]);
    expect((await getRecentMessages(bobs)).map((m) => m.content)).toEqual(["قبلی باب"]);
  });
});

describe("update inbox (no message lost, none handled twice)", () => {
  const text = (updateId: number, chatId = 7) => ({ update_id: updateId, message: { chat: { id: chatId }, text: "سؤال" } });

  it("records an update once; a repeat delivery is not new", async () => {
    expect(await receiveUpdate(text(100))).toBe(true);
    expect(await receiveUpdate(text(100))).toBe(false);
  });

  it("lists failed updates and stale received ones, not done, abandoned or running ones", async () => {
    for (const id of [101, 102, 103, 104, 105]) await receiveUpdate(text(id));
    await finishUpdate(101, true);
    await finishUpdate(102, false);
    await abandonUpdate(103);
    await pool.query(`UPDATE processed_updates SET updated_at = now() - interval '10 minutes' WHERE update_id IN (104, 105)`);

    const unfinished = await listUnfinishedUpdates(2 * 60_000, [105]);

    expect(unfinished.map((update) => [update.updateId, update.status])).toEqual([
      [102, "failed"],
      [104, "received"],
    ]);
    expect(unfinished[0]!.payload).toEqual(text(102));
    expect(await listUnfinishedUpdates(2 * 60_000, [])).toHaveLength(3); // 105 too, once it is not running
  });

  it("a claim counts the attempt and works once", async () => {
    await receiveUpdate(text(106));
    await finishUpdate(106, false);

    expect(await claimRetry(106, "failed")).toBe(true);
    expect(await claimRetry(106, "failed")).toBe(false);
    const { rows } = await pool.query(`SELECT status, attempts FROM processed_updates WHERE update_id = 106`);
    expect(rows[0]).toEqual({ status: "received", attempts: 2 });
  });

  it("knows when the same chat sent a newer text message", async () => {
    await receiveUpdate(text(107, 70));
    await receiveUpdate(text(108, 71));
    expect(await hasLaterMessage(70, 107)).toBe(false);

    await receiveUpdate(text(109, 70));
    expect(await hasLaterMessage(70, 107)).toBe(true);
  });

  it("one conversation per user, however often it is requested", async () => {
    const alice = await addUser("alice");

    expect(await findOrCreateConversation(alice)).toBe(await findOrCreateConversation(alice));
  });
});

describe("enrichment (background, after upload)", () => {
  const profile = { title: "سیستم‌های خبره", summary: "خلاصه", topics: ["تعریف", "خصوصیات"] };
  const section = (sectionIndex: number) => ({ sectionIndex, pageStart: 1, pageEnd: 2, summary: `بخش ${sectionIndex}` });
  const chunkIds = async (documentId: number) =>
    (await pool.query<{ id: number }>("SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index", [documentId])).rows.map((r) => r.id);
  const enriched = (chunkId: number) => ({
    chunkId,
    context: "زمینه",
    contextEmbedding: axis(3),
    questions: [{ question: "سیستم خبره چیه؟", embedding: axis(4) }],
  });

  it("stores the profile, sections, chunk context and questions, and replaces them when redone", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [1, 2]);
    const [first, second] = await chunkIds(documentId);

    await saveEnrichment(documentId, profile, [section(0), section(1)], [enriched(first!), enriched(second!)]);
    await saveEnrichment(documentId, profile, [section(0)], [enriched(first!)]);

    const document = await pool.query("SELECT title, topics, enrichment FROM documents WHERE id = $1", [documentId]);
    expect(document.rows[0]).toEqual({ title: profile.title, topics: profile.topics, enrichment: "done" });
    expect(await getSectionSummaries(alice, documentId)).toHaveLength(1);
    const questions = await pool.query("SELECT count(*)::int AS n FROM chunk_questions");
    expect(questions.rows[0].n).toBe(1);
  });

  it("never shows one user's section summaries to another", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const bobsDocument = await addDocument(bob, "b.pdf", [1]);
    await saveEnrichment(bobsDocument, profile, [section(0)], []);

    expect(await getSectionSummaries(alice, bobsDocument)).toEqual([]);
    expect(await getSectionSummaries(bob, bobsDocument)).toHaveLength(1);
  });

  it("deleting a document deletes its sections and questions", async () => {
    const alice = await addUser("alice");
    const documentId = await addDocument(alice, "a.pdf", [1]);
    const [chunkId] = await chunkIds(documentId);
    await saveEnrichment(documentId, profile, [section(0)], [enriched(chunkId!)]);

    await deleteDocument(alice, documentId);

    const left = await pool.query(
      "SELECT (SELECT count(*) FROM document_sections)::int AS sections, (SELECT count(*) FROM chunk_questions)::int AS questions",
    );
    expect(left.rows[0]).toEqual({ sections: 0, questions: 0 });
  });

  it("the worker takes queued documents oldest first, and requeues interrupted ones after a restart", async () => {
    const alice = await addUser("alice");
    const older = await addDocument(alice, "a.pdf", [1]);
    const newer = await addDocument(alice, "b.pdf", [2]);
    await addDocument(alice, "busy.pdf", [], "processing");
    await setEnrichmentStatus(older, "pending");
    await setEnrichmentStatus(newer, "pending");

    expect(await claimPendingDocument()).toBe(older);
    expect(await claimPendingDocument()).toBe(newer);
    expect(await claimPendingDocument()).toBeNull();

    expect(await resetRunningEnrichment()).toBe(2);
    expect(await claimPendingDocument()).toBe(older);
  });

  it("an upload is queued for enrichment once it is ready", async () => {
    const alice = await addUser("alice");
    vi.mocked(openPdf).mockResolvedValue({
      pages: [{ pageNumber: 1, method: "text", text: "این متن صفحه اول از جزوه آزمایشی است و به اندازه کافی طولانی است #1" }],
      renderPage: vi.fn(),
      close: vi.fn(async () => {}),
    });

    const { documentId } = await ingestDocument(alice, "notes.pdf", "x.pdf");

    const row = await pool.query("SELECT enrichment FROM documents WHERE id = $1", [documentId]);
    expect(row.rows[0].enrichment).toBe("pending");
  });
});

describe("question index (enriched documents)", () => {
  const rag = config.rag as { questionIndex: boolean };
  const { questionIndex } = config.rag;
  const questionAbout = (axisIndex: number) => ({ question: `سؤال #${axisIndex}`, embedding: axis(axisIndex) });

  /** Gives every chunk of a document one stored question on the given axes. */
  async function addQuestions(userId: number, documentId: number, axes: number[]) {
    const ids = (
      await pool.query<{ id: number }>(
        "SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index",
        [documentId],
      )
    ).rows.map((row) => row.id);
    await saveEnrichment(
      documentId,
      { title: "t", summary: "", topics: [] },
      [],
      ids.map((chunkId, i) => ({ chunkId, context: "c", contextEmbedding: axis(0), questions: [questionAbout(axes[i]!)] })),
    );
  }

  it("finds a chunk through a stored question its own text is far from", async () => {
    rag.questionIndex = true;
    try {
      const alice = await addUser("alice");
      const documentId = await addDocument(alice, "a.pdf", [5, 6]);
      // Chunk 1's text is far from the question (#7), but it answers a stored question on #7.
      await addQuestions(alice, documentId, [8, 7]);

      const candidates = await searchCandidates(alice, "#7", 10, documentId);

      expect(candidates.map((chunk) => chunk.chunkIndex)).toEqual([1]);
    } finally {
      rag.questionIndex = questionIndex;
    }
  });

  it("never matches another user's stored questions", async () => {
    rag.questionIndex = true;
    try {
      const alice = await addUser("alice");
      const bob = await addUser("bob");
      const bobsDocument = await addDocument(bob, "b.pdf", [5]);
      await addQuestions(bob, bobsDocument, [7]);

      await expect(searchCandidates(alice, "#7", 10)).resolves.toEqual([]);
    } finally {
      rag.questionIndex = questionIndex;
    }
  });
});
