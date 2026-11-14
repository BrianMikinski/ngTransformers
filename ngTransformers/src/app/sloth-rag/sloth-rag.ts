import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DocumentParserService, ExtractedDocument } from './document-parser.service';
import { EmbeddingService } from './embedding.service';
import { SqliteStoreService } from './sqlite-store.service';
import { DuckDbService, SqlResult, TableInfo } from './duckdb.service';
import {
  ChunkRow, DocumentSummary, SearchHit, Segment, Span,
  chunkText, dot, highlightSegments, queryTerms, splitSentences, toTableName, vectorGradient,
} from './rag-utils';

const EMBED_BATCH = 16;
/** all-MiniLM-L6-v2 cosine: ~0.3+ is usually related, ~0 is unrelated. */
const MIN_SENTENCE_SIMILARITY = 0.25;

interface ImportEntry {
  file: string;
  type?: string;
  status: 'ok' | 'warn' | 'error';
  details: string[];
  ms: number;
}

interface DisplayHit extends SearchHit {
  segments: Segment[];
  sentenceScore?: number;
}

interface DisplayChunk extends ChunkRow {
  gradient: string;
  preview: string;
}

@Component({
  selector: 'app-sloth-rag',
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './sloth-rag.html',
})
export class SlothRag {
  #parser = inject(DocumentParserService);
  #embedder = inject(EmbeddingService);
  #store = inject(SqliteStoreService);
  #duck = inject(DuckDbService);

  docs = signal<ExtractedDocument[]>([]);
  importLog = signal<ImportEntry[]>([]);
  errors = signal<string[]>([]);
  results = signal<DisplayHit[]>([]);
  documents = signal<DocumentSummary[]>([]);
  selectedDoc = signal<string | undefined>(undefined);
  docChunks = signal<DisplayChunk[]>([]);
  tables = signal<TableInfo[]>([]);
  sqlResult = signal<SqlResult | undefined>(undefined);
  chunkCount = signal(0);
  storage = signal('opening SQLite...');
  status = signal('');
  busy = signal(false);

  constructor() {
    this.#store.storage().then(s => this.storage.set(s), e => {
      this.storage.set('SQLite unavailable');
      this.#error('SQLite', e);
    });
    this.#refreshIndex();
  }

  async onFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    this.busy.set(true);
    for (const file of files) {
      const entry = await this.#import(file);
      this.importLog.update(log => [...log, entry]);
    }
    input.value = ''; // allow re-selecting the same file
    this.status.set('');
    this.busy.set(false);
    await this.#refreshIndex();
  }

  async search(query: string) {
    if (!query.trim()) return;
    await this.#run('Searching... (first search may download the embedding model)', async () => {
      const [vector] = await this.#embedder.embed([query]);
      const hits = await this.#store.search(query, vector, 5);

      // Semantic highlight: embed each sentence of each hit, mark the one closest to the query.
      const sentences = hits.map(h => splitSentences(h.text));
      const toEmbed = sentences.flatMap((ss, i) => ss.length > 1 ? ss.map(s => hits[i].text.slice(s.start, s.end)) : []);
      const sentenceVectors = toEmbed.length ? await this.#embedder.embed(toEmbed) : [];

      const terms = queryTerms(query);
      let next = 0;
      this.results.set(hits.map((hit, i) => {
        let best: (Span & { score: number }) | undefined;
        if (sentences[i].length > 1) {
          for (const s of sentences[i]) {
            const score = dot(vector, sentenceVectors[next++]);
            if (!best || score > best.score) best = { ...s, score };
          }
        }
        // Only highlight a sentence that's actually related; otherwise the "best" of bad options misleads.
        const semantic = best && best.score >= MIN_SENTENCE_SIMILARITY ? best : undefined;
        return { ...hit, segments: highlightSegments(hit.text, terms, semantic), sentenceScore: best?.score };
      }));
    });
  }

  async runSql(sql: string) {
    await this.#run('Running SQL...', async () => this.sqlResult.set(await this.#duck.query(sql)));
  }

  async viewDocument(docName: string) {
    if (this.selectedDoc() === docName) {
      this.selectedDoc.set(undefined);
      return;
    }
    await this.#run(`Loading chunks for ${docName}...`, async () => {
      const rows = await this.#store.chunks(docName);
      this.docChunks.set(rows.map(r => ({
        ...r,
        gradient: vectorGradient(r.vector),
        preview: Array.from(r.vector.slice(0, 4), x => x.toFixed(3)).join(', ') + ', …',
      })));
      this.selectedDoc.set(docName);
    });
  }

  async clearIndex() {
    await this.#run('Clearing index...', async () => {
      await this.#store.clear();
      this.results.set([]);
      this.selectedDoc.set(undefined);
      await this.#refreshIndex();
    });
  }

  /** Parse → (DuckDB for spreadsheets) → chunk → embed → SQLite. Never throws; returns a log entry. */
  async #import(file: File): Promise<ImportEntry> {
    const start = performance.now();
    const entry: ImportEntry = { file: file.name, status: 'ok', details: [], ms: 0 };
    const warn = (msg: string) => { entry.status = 'warn'; entry.details.push(msg); };

    try {
      this.status.set(`Parsing ${file.name}...`);
      const doc = await this.#parser.parse(file);
      entry.type = doc.type;
      this.docs.update(d => [...d.filter(x => x.name !== doc.name), doc]);

      if (doc.sheets) {
        const { loaded, failures } = await this.#loadSheets(doc);
        entry.details.push(`${loaded} table(s) loaded into DuckDB`);
        failures.forEach(warn);
      }

      if (!doc.text.trim()) {
        warn(`No text extracted, nothing indexed${doc.type === 'pdf' ? ' (scanned / image-only PDF?)' : ''}`);
      } else {
        const chunks = await this.#index(doc);
        entry.details.unshift(`${chunks} chunk(s) indexed`);
      }
    } catch (e) {
      entry.status = 'error';
      entry.details.push(message(e));
      console.error(`[sloth-rag] import failed for ${file.name}`, e);
    }
    entry.ms = Math.round(performance.now() - start);
    return entry;
  }

  async #index(doc: ExtractedDocument): Promise<number> {
    const chunks = chunkText(doc.text);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      this.status.set(`Embedding ${doc.name}: ${i}/${chunks.length} chunks (first run downloads the model)...`);
      vectors.push(...await this.#embedder.embed(chunks.slice(i, i + EMBED_BATCH)));
    }
    this.status.set(`Saving ${doc.name} to SQLite...`);
    await this.#store.replaceDocument(doc.name, chunks.map((text, index) => ({ index, text, vector: vectors[index] })));
    return chunks.length;
  }

  async #loadSheets(doc: ExtractedDocument): Promise<{ loaded: number; failures: string[] }> {
    this.status.set(`Loading ${doc.name} into DuckDB (first time downloads ~34MB)...`);
    const isCsv = doc.name.toLowerCase().endsWith('.csv');
    let loaded = 0;
    const failures: string[] = [];
    for (const sheet of doc.sheets!) {
      const label = isCsv ? 'CSV' : `Sheet "${sheet.name}"`;
      if (!sheet.csv.trim()) {
        failures.push(`${label} is empty, skipped`);
        continue;
      }
      try {
        await this.#duck.loadCsv(toTableName(doc.name, isCsv ? undefined : sheet.name), sheet.csv);
        loaded++;
      } catch (e) {
        failures.push(`${label} failed to load into DuckDB: ${message(e)}`);
      }
    }
    if (loaded) this.tables.set(await this.#duck.tables());
    return { loaded, failures };
  }

  async #run(status: string, fn: () => Promise<void>) {
    this.busy.set(true);
    this.status.set(status);
    try {
      await fn();
    } catch (e) {
      this.#error(status.replace(/\.\.\..*/, ''), e);
    }
    this.status.set('');
    this.busy.set(false);
  }

  async #refreshIndex() {
    try {
      const [count, documents] = await Promise.all([this.#store.count(), this.#store.documents()]);
      this.chunkCount.set(count);
      this.documents.set(documents);
    } catch (e) {
      this.#error('SQLite', e);
    }
  }

  #error(context: string, e: unknown) {
    console.error(`[sloth-rag] ${context}`, e);
    this.errors.update(errs => [...errs, `${context}: ${message(e)}`]);
  }
}

function message(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}
