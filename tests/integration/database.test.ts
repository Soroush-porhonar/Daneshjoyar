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
const { findOrCreateConversation, getSelectedDocumentId, selectDocument } = await import(
  "../../src/db/conversations.js"
);
const {
  deleteDocument,
  failInterruptedDocuments,
  findDocumentFilename,
  findDuplicateDocument,
  listCompletedFilenames,
} = await import(
  "../../src/db/documents.js"
);
const { isUpdateProcessed, markUpdateProcessed } = await import("../../src/db/updates.js");
const { createAnswerLog, getLastAnswerHits, setFeedback } = await import("../../src/db/answerLogs.js");
const { getDocumentChunks, retrieveContext, retrieveRelevantChunks, searchCandidates } = await import(
  "../../src/rag/retrieve.js"
);
const { ingestPdf } = await import("../../src/rag/ingest.js");
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

  it("cannot select, see or delete another user's document", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    const bobsDocument = await addDocument(bob, "bob.pdf", [1]);

    expect(await selectDocument(alice, bobsDocument)).toBe(false);
    expect(await getSelectedDocumentId(alice)).toBeNull();
    expect(await findDocumentFilename(alice, bobsDocument)).toBeNull();
    expect(await deleteDocument(alice, bobsDocument)).toBe(false);
    expect(await findDocumentFilename(bob, bobsDocument)).toBe("bob.pdf");
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

  it("only completed documents can be selected", async () => {
    const alice = await addUser("alice");
    const failed = await addDocument(alice, "broken.pdf", [], "failed");
    const ready = await addDocument(alice, "ready.pdf", [1]);

    expect(await selectDocument(alice, failed)).toBe(false);
    expect(await selectDocument(alice, ready)).toBe(true);
    expect(await getSelectedDocumentId(alice)).toBe(ready);
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

describe("ingestPdf", () => {
  const page = (pageNumber: number, marker: string) => ({
    pageNumber,
    method: "text" as const,
    text: `این متن صفحه ${pageNumber} از جزوه آزمایشی است و به اندازه کافی طولانی است ${marker}`,
  });

  it("stores page-tagged chunks, completes the document and selects it", async () => {
    const alice = await addUser("alice");
    vi.mocked(openPdf).mockResolvedValue({
      pages: [page(1, "#1"), page(2, "#2")],
      renderPage: vi.fn(),
      close: vi.fn(async () => {}),
    });

    const result = await ingestPdf(alice, "notes.pdf", "ignored.pdf");

    expect(result).toMatchObject({ pageCount: 2, ocrPages: 0 });
    expect(await listCompletedFilenames(alice)).toEqual(["notes.pdf"]);
    expect(await getSelectedDocumentId(alice)).toBe(result.documentId);

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

    await expect(ingestPdf(alice, "notes.pdf", "ignored.pdf")).rejects.toThrow("ollama down");

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
    const { documentId } = await ingestPdf(alice, "notes.pdf", "x.pdf", undefined, 1234);

    expect(await findDuplicateDocument(alice, "notes.pdf", 1234)).toEqual({ id: documentId, status: "completed" });
    expect(await findDuplicateDocument(bob, "notes.pdf", 1234)).toBeNull();
    expect(await findDuplicateDocument(alice, "notes.pdf", 999)).toBeNull();
  });

  it("the database refuses a second copy, even if the check was skipped", async () => {
    const alice = await addUser("alice");
    await ingestPdf(alice, "notes.pdf", "x.pdf", undefined, 1234);

    await expect(ingestPdf(alice, "notes.pdf", "x.pdf", undefined, 1234)).rejects.toBeInstanceOf(
      DuplicateDocumentError,
    );
  });

  it("a failed upload does not block sending the file again", async () => {
    const alice = await addUser("alice");
    vi.mocked(generateEmbeddings).mockRejectedValueOnce(new Error("ollama down"));
    await expect(ingestPdf(alice, "notes.pdf", "x.pdf", undefined, 1234)).rejects.toThrow();

    expect(await findDuplicateDocument(alice, "notes.pdf", 1234)).toBeNull();
    await expect(ingestPdf(alice, "notes.pdf", "x.pdf", undefined, 1234)).resolves.toBeTruthy();
  });

  it("scripts that re-ingest on purpose (no size) are not blocked", async () => {
    const alice = await addUser("alice");
    await ingestPdf(alice, "notes.pdf", "x.pdf");

    await expect(ingestPdf(alice, "notes.pdf", "x.pdf")).resolves.toBeTruthy();
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
    documentId: null,
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
      documentId,
      context: [
        { page: 1, chunkIndex: 0, isHit: false },
        { page: 2, chunkIndex: 1, isHit: true },
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
    await createAnswerLog({
      ...log(alice),
      documentId: first,
      context: [
        { documentId: second, page: 1, chunkIndex: 0, isHit: true },
        { page: 4, chunkIndex: 3, isHit: true }, // logged before chunks named their document
      ],
    });

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

describe("processed updates (no message is handled twice)", () => {
  it("remembers processed updates and tolerates marking twice", async () => {
    expect(await isUpdateProcessed(100)).toBe(false);

    await markUpdateProcessed(100);
    await markUpdateProcessed(100);

    expect(await isUpdateProcessed(100)).toBe(true);
  });

  it("one conversation per user, however often it is requested", async () => {
    const alice = await addUser("alice");

    expect(await findOrCreateConversation(alice)).toBe(await findOrCreateConversation(alice));
  });
});
