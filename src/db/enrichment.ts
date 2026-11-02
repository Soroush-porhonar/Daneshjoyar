import { pool } from "./pool.js";

export interface EnrichmentChunk {
  id: number;
  chunkIndex: number;
  pageNumber: number | null;
  pageEnd: number | null;
  sectionTitle: string | null;
  content: string;
}

export interface SectionSummary {
  sectionIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  summary: string;
}

export interface DocumentProfile {
  title: string;
  summary: string;
  topics: string[];
}

export interface ChunkEnrichment {
  chunkId: number;
  context: string;
  contextEmbedding: number[];
  questions: { question: string; embedding: number[] }[];
}

const vector = (values: number[]) => `[${values.join(",")}]`;

/** After a restart nothing is really running: interrupted enrichment starts again. */
export async function resetRunningEnrichment(): Promise<number> {
  const result = await pool.query(
    `UPDATE documents SET enrichment = 'pending' WHERE enrichment = 'running'`,
  );
  return result.rowCount ?? 0;
}

/** Takes the oldest ready document waiting for enrichment and marks it running. */
export async function claimPendingDocument(): Promise<number | null> {
  const result = await pool.query<{ id: number }>(
    `UPDATE documents SET enrichment = 'running'
     WHERE id = (
       SELECT id FROM documents
       WHERE enrichment = 'pending' AND status = 'completed'
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
  );
  return result.rows[0]?.id ?? null;
}

export async function setEnrichmentStatus(
  documentId: number,
  status: "pending" | "running" | "done" | "failed",
): Promise<void> {
  await pool.query(`UPDATE documents SET enrichment = $2 WHERE id = $1`, [documentId, status]);
}

/** Ready documents to enrich: all, one user's, or given ids; done ones only with `force`. */
export async function documentsToEnrich(
  filter: { userId?: number; documentIds?: number[]; force?: boolean },
): Promise<number[]> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM documents
     WHERE status = 'completed'
       AND ($1::integer IS NULL OR user_id = $1)
       AND ($2::integer[] IS NULL OR id = ANY($2))
       AND ($3 OR enrichment IS DISTINCT FROM 'done')
     ORDER BY id`,
    [filter.userId ?? null, filter.documentIds ?? null, filter.force ?? false],
  );
  return result.rows.map((row) => row.id);
}

/** The document and its chunks in reading order. */
export async function loadDocumentForEnrichment(
  documentId: number,
): Promise<{ filename: string; chunks: EnrichmentChunk[] } | null> {
  const document = await pool.query<{ filename: string }>(
    `SELECT filename FROM documents WHERE id = $1 AND status = 'completed'`,
    [documentId],
  );
  if (!document.rows[0]) return null;

  const chunks = await pool.query<EnrichmentChunk>(
    `SELECT id, chunk_index AS "chunkIndex", page_number AS "pageNumber", page_end AS "pageEnd",
            section_title AS "sectionTitle", content
     FROM document_chunks
     WHERE document_id = $1
     ORDER BY page_number ASC NULLS LAST, chunk_index ASC`,
    [documentId],
  );

  return { filename: document.rows[0].filename, chunks: chunks.rows };
}

/** Stores everything at once, replacing an earlier enrichment, and marks the document done. */
export async function saveEnrichment(
  documentId: number,
  profile: DocumentProfile,
  sections: SectionSummary[],
  chunks: ChunkEnrichment[],
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE documents SET title = $2, summary = $3, topics = $4, enrichment = 'done' WHERE id = $1`,
      [documentId, profile.title, profile.summary, profile.topics],
    );
    await client.query(`DELETE FROM document_sections WHERE document_id = $1`, [documentId]);

    for (const section of sections) {
      await client.query(
        `INSERT INTO document_sections (document_id, section_index, page_start, page_end, summary)
         VALUES ($1, $2, $3, $4, $5)`,
        [documentId, section.sectionIndex, section.pageStart, section.pageEnd, section.summary],
      );
    }

    await client.query(
      `DELETE FROM chunk_questions
       WHERE chunk_id IN (SELECT id FROM document_chunks WHERE document_id = $1)`,
      [documentId],
    );

    for (const chunk of chunks) {
      // The document_id check keeps a chunk of another document from being changed.
      await client.query(
        `UPDATE document_chunks SET context = $3, context_embedding = $4::vector
         WHERE id = $1 AND document_id = $2`,
        [chunk.chunkId, documentId, chunk.context, vector(chunk.contextEmbedding)],
      );

      for (const question of chunk.questions) {
        await client.query(
          `INSERT INTO chunk_questions (chunk_id, question, embedding) VALUES ($1, $2, $3::vector)`,
          [chunk.chunkId, question.question, vector(question.embedding)],
        );
      }
    }

    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Stored section summaries of a document, in order (summary requests use them). */
export async function getSectionSummaries(
  userId: number,
  documentId: number,
): Promise<SectionSummary[]> {
  const result = await pool.query<SectionSummary>(
    `SELECT s.section_index AS "sectionIndex", s.page_start AS "pageStart",
            s.page_end AS "pageEnd", s.summary
     FROM document_sections s
     JOIN documents d ON d.id = s.document_id
     WHERE d.user_id = $1 AND d.id = $2 AND d.enrichment = 'done'
     ORDER BY s.section_index`,
    [userId, documentId],
  );
  return result.rows;
}
