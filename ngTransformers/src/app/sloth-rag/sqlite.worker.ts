/// <reference lib="webworker" />
/**
 * SQLite (WASM) running in a Web Worker, persisted to OPFS via the "opfs-sahpool" VFS.
 * opfs-sahpool needs no COOP/COEP headers, so it works on GitHub Pages.
 * Hybrid search = FTS5 keyword ranking + brute-force cosine ranking, fused with RRF.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { ChunkInput, SearchHit, dot, reciprocalRankFusion, toFtsQuery } from './rag-utils';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chunks (
    id       INTEGER PRIMARY KEY,
    doc_name TEXT    NOT NULL,
    idx      INTEGER NOT NULL,
    text     TEXT    NOT NULL,
    vector   BLOB    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_name);

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`;

const CANDIDATES = 20; // how many results each ranker contributes before fusion

let dbPromise: Promise<{ db: any; storage: string }> | undefined;
let vectorCache: { id: number; vector: Float32Array }[] | undefined;

function open() {
  return dbPromise ??= (async () => {
    const sqlite3 = await sqlite3InitModule();
    let db: any;
    let storage: string;
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({});
      db = new pool.OpfsSAHPoolDb('/sloth-rag.sqlite3');
      storage = 'SQLite in OPFS (persistent)';
    } catch (e) {
      // e.g. unsupported browser, or another tab already holds the OPFS pool.
      console.warn('[sloth-rag] OPFS unavailable, falling back to in-memory SQLite:', e);
      db = new sqlite3.oo1.DB(':memory:');
      storage = 'SQLite in memory (NOT persistent - OPFS unavailable)';
    }
    db.exec(SCHEMA);
    return { db, storage };
  })();
}

const api = {
  async storage(): Promise<string> {
    return (await open()).storage;
  },

  async count(): Promise<number> {
    const { db } = await open();
    return db.selectValue('SELECT count(*) FROM chunks');
  },

  async clear(): Promise<void> {
    const { db } = await open();
    db.exec('DELETE FROM chunks');
    vectorCache = undefined;
  },

  /** Replaces all chunks for a document, so re-uploading doesn't duplicate. */
  async replaceDocument(docName: string, chunks: ChunkInput[]): Promise<void> {
    const { db } = await open();
    db.transaction(() => {
      db.exec({ sql: 'DELETE FROM chunks WHERE doc_name = ?', bind: [docName] });
      const stmt = db.prepare('INSERT INTO chunks (doc_name, idx, text, vector) VALUES (?, ?, ?, ?)');
      try {
        for (const c of chunks) {
          const blob = new Uint8Array(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength);
          stmt.bind([docName, c.index, c.text, blob]).stepReset();
        }
      } finally {
        stmt.finalize();
      }
    });
    vectorCache = undefined;
  },

  async search(query: string, queryVector: Float32Array, k = 5): Promise<SearchHit[]> {
    const { db } = await open();

    // 1) Vector ranking: brute-force cosine over all chunks (vectors cached in memory).
    vectorCache ??= db.selectArrays('SELECT id, vector FROM chunks').map(([id, blob]: [number, Uint8Array]) => ({
      id,
      vector: new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)),
    }));
    const byVector = vectorCache!
      .map(c => ({ id: c.id, similarity: dot(queryVector, c.vector) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CANDIDATES);

    // 2) Keyword ranking: FTS5 BM25.
    const fts = toFtsQuery(query);
    const byKeyword: number[] = fts
      ? db.selectArrays('SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?', [fts, CANDIDATES])
          .map((r: [number]) => r[0])
      : [];

    // 3) Fuse and hydrate the top k.
    const top = reciprocalRankFusion([byVector.map(v => v.id), byKeyword]).slice(0, k);
    if (!top.length) return [];

    const rows: any[] = db.selectObjects(
      `SELECT id, doc_name, idx, text FROM chunks WHERE id IN (${top.map(() => '?').join(',')})`,
      top.map(t => t.id));
    const rowById = new Map(rows.map(r => [r.id, r]));

    return top.map(({ id, score }) => {
      const row = rowById.get(id);
      const vi = byVector.findIndex(v => v.id === id);
      const ki = byKeyword.indexOf(id);
      return {
        id, score, docName: row.doc_name, index: row.idx, text: row.text,
        similarity: vi >= 0 ? byVector[vi].similarity : undefined,
        vectorRank: vi >= 0 ? vi + 1 : undefined,
        keywordRank: ki >= 0 ? ki + 1 : undefined,
      };
    });
  },
};

addEventListener('message', async ({ data: { id, method, args } }) => {
  try {
    const result = await (api as any)[method](...args);
    postMessage({ id, result });
  } catch (e: any) {
    postMessage({ id, error: e?.message ?? String(e) });
  }
});
