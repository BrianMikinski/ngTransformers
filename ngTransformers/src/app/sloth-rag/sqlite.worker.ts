/// <reference lib="webworker" />
/**
 * SQLite (WASM) running in a Web Worker, persisted to OPFS via the "opfs-sahpool" VFS.
 * opfs-sahpool needs no COOP/COEP headers, so it works on GitHub Pages.
 * Hybrid search = FTS5 keyword ranking + brute-force cosine ranking, fused with RRF.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  ChunkInput, ChunkRow, DocumentSummary, SearchHit, StorageState, StoredDocument, dot, reciprocalRankFusion,
  toFtsQuery,
} from './rag-utils';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chunks (
    id        INTEGER PRIMARY KEY,
    doc_name  TEXT    NOT NULL,
    idx       INTEGER NOT NULL,
    text      TEXT    NOT NULL,
    vector    BLOB    NOT NULL,
    start_pos INTEGER,          -- offsets into documents.text (NULL for rows from schema v1)
    end_pos   INTEGER,
    section   TEXT              -- "Page 3", "Sheet Sales", ...
  );
  CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_name);

  CREATE TABLE IF NOT EXISTS documents (
    name     TEXT PRIMARY KEY,
    type     TEXT    NOT NULL,
    text     TEXT    NOT NULL,
    sheets   TEXT,              -- JSON [{name, csv}] for spreadsheets
    added_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`;

const SCHEMA_VERSION = 2;

/** v1 → v2: passage offsets + section labels on chunks (the documents table is created by SCHEMA). */
function migrate(db: any) {
  const version: number = db.selectValue('PRAGMA user_version');
  if (version >= SCHEMA_VERSION) return;
  const columns: string[] = db.selectValues(`SELECT name FROM pragma_table_info('chunks')`);
  for (const [col, type] of [['start_pos', 'INTEGER'], ['end_pos', 'INTEGER'], ['section', 'TEXT']]) {
    if (!columns.includes(col)) db.exec(`ALTER TABLE chunks ADD COLUMN ${col} ${type}`);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

const CANDIDATES = 20; // how many results each ranker contributes before fusion

const LOCK_NAME = 'sloth-rag-db';

let dbPromise: Promise<{ db: any; storage: StorageState }> | undefined;
let vectorCache: { id: number; vector: Float32Array }[] | undefined;

/** Tell the UI about storage changes (not tied to a request id). */
function emitState(state: StorageState) {
  postMessage({ event: 'state', state });
}

/**
 * opfs-sahpool gives one tab exclusive access to the database file. A Web Lock makes that explicit:
 * a second tab waits here (and says so) instead of silently falling back to memory. When the owning
 * tab's worker is terminated ("Use here" in another tab), its lock is released and we get it.
 */
function acquireLock(): Promise<void> {
  if (!navigator.locks) return Promise.resolve();
  return new Promise<void>(acquired => {
    const hold = () => { acquired(); return new Promise<void>(() => {}); }; // held until the worker dies
    navigator.locks.request(LOCK_NAME, { ifAvailable: true }, lock => {
      if (lock) return hold();
      emitState('waiting');
      return navigator.locks.request(LOCK_NAME, hold);
    });
  });
}

function open() {
  return dbPromise ??= (async () => {
    const sqlite3 = await sqlite3InitModule();
    let db: any;
    let storage: StorageState;
    try {
      await acquireLock();
      const pool = await installPool(sqlite3);
      db = new pool.OpfsSAHPoolDb('/sloth-rag.sqlite3');
      storage = 'persistent';
    } catch (e) {
      // e.g. unsupported browser (no OPFS sync access handles).
      console.warn('[sloth-rag] OPFS unavailable, falling back to in-memory SQLite:', e);
      db = new sqlite3.oo1.DB(':memory:');
      storage = 'memory';
    }
    db.exec(SCHEMA);
    migrate(db);
    emitState(storage);
    return { db, storage };
  })();
}

/** The previous owner's file handles can close a moment after its lock is released, so retry briefly. */
async function installPool(sqlite3: any, attempts = 10): Promise<any> {
  for (let i = 1; ; i++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ forceReinitIfPreviouslyFailed: true });
    } catch (e) {
      if (i >= attempts || !navigator.locks) throw e;
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

const api = {
  async storage(): Promise<StorageState> {
    return (await open()).storage;
  },

  async count(): Promise<number> {
    const { db } = await open();
    return db.selectValue('SELECT count(*) FROM chunks');
  },

  async documents(): Promise<DocumentSummary[]> {
    const { db } = await open();
    return db.selectObjects(`
      SELECT c.doc_name AS docName, count(*) AS chunks,
             coalesce(length(d.text), sum(length(c.text))) AS chars,
             d.type AS type, d.name IS NOT NULL AS hasText
      FROM chunks c LEFT JOIN documents d ON d.name = c.doc_name
      GROUP BY c.doc_name ORDER BY c.doc_name`)
      .map((r: any) => ({ ...r, hasText: !!r.hasText, type: r.type ?? undefined }));
  },

  async document(name: string): Promise<StoredDocument | undefined> {
    const { db } = await open();
    const row = db.selectObject('SELECT name, type, text, sheets FROM documents WHERE name = ?', [name]);
    return row && { name: row.name, type: row.type, text: row.text, sheets: row.sheets ? JSON.parse(row.sheets) : undefined };
  },

  async chunks(docName: string, limit = 200): Promise<ChunkRow[]> {
    const { db } = await open();
    return db.selectObjects('SELECT id, idx, text, vector FROM chunks WHERE doc_name = ? ORDER BY idx LIMIT ?', [docName, limit])
      .map((r: any) => ({ id: r.id, index: r.idx, text: r.text, vector: toFloat32(r.vector) }));
  },

  async deleteDocument(docName: string): Promise<void> {
    const { db } = await open();
    db.transaction(() => {
      db.exec({ sql: 'DELETE FROM chunks WHERE doc_name = ?', bind: [docName] });
      db.exec({ sql: 'DELETE FROM documents WHERE name = ?', bind: [docName] });
    });
    vectorCache = undefined;
  },

  async clear(): Promise<void> {
    const { db } = await open();
    db.exec('DELETE FROM chunks; DELETE FROM documents;');
    vectorCache = undefined;
  },

  /** Stores a document's text and replaces all its chunks, so re-uploading doesn't duplicate. */
  async replaceDocument(doc: StoredDocument, chunks: ChunkInput[]): Promise<void> {
    const { db } = await open();
    db.transaction(() => {
      db.exec({ sql: 'DELETE FROM chunks WHERE doc_name = ?', bind: [doc.name] });
      db.exec({
        sql: 'INSERT OR REPLACE INTO documents (name, type, text, sheets, added_at) VALUES (?, ?, ?, ?, ?)',
        bind: [doc.name, doc.type, doc.text, doc.sheets ? JSON.stringify(doc.sheets) : null, Date.now()],
      });
      const stmt = db.prepare(
        'INSERT INTO chunks (doc_name, idx, text, vector, start_pos, end_pos, section) VALUES (?, ?, ?, ?, ?, ?, ?)');
      try {
        for (const c of chunks) {
          const blob = new Uint8Array(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength);
          stmt.bind([doc.name, c.index, c.text, blob, c.start, c.end, c.section ?? null]).stepReset();
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
    vectorCache ??= db.selectArrays('SELECT id, vector FROM chunks')
      .map(([id, blob]: [number, Uint8Array]) => ({ id, vector: toFloat32(blob) }));
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
      `SELECT id, doc_name, idx, text, start_pos, end_pos, section FROM chunks WHERE id IN (${top.map(() => '?').join(',')})`,
      top.map(t => t.id));
    const rowById = new Map(rows.map(r => [r.id, r]));

    return top.map(({ id, score }) => {
      const row = rowById.get(id);
      const vi = byVector.findIndex(v => v.id === id);
      const ki = byKeyword.indexOf(id);
      return {
        id, score, docName: row.doc_name, index: row.idx, text: row.text,
        start: row.start_pos ?? undefined, end: row.end_pos ?? undefined, section: row.section ?? undefined,
        similarity: vi >= 0 ? byVector[vi].similarity : undefined,
        vectorRank: vi >= 0 ? vi + 1 : undefined,
        keywordRank: ki >= 0 ? ki + 1 : undefined,
      };
    });
  },
};

function toFloat32(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

addEventListener('message', async ({ data: { id, method, args } }) => {
  try {
    const result = await (api as any)[method](...args);
    postMessage({ id, result });
  } catch (e: any) {
    postMessage({ id, error: e?.message ?? String(e) });
  }
});
