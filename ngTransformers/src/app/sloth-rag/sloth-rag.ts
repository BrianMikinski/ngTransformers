import {
  Component, ChangeDetectionStrategy, Injector, afterNextRender, computed, inject, signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DocumentParserService, ExtractedDocument, SUPPORTED_EXTENSIONS } from './document-parser.service';
import { EmbeddingService } from './embedding.service';
import { SqliteStoreService } from './sqlite-store.service';
import { DuckDbService, SqlResult } from './duckdb.service';
import {
  ChunkRow, DocumentSummary, SearchHit, Segment, Span,
  chunkText, dot, fileExtension, groupHits, highlightSegments, isStrongHit, queryTerms, splitSentences,
  toTableName, vectorGradient,
} from './rag-utils';

const EMBED_BATCH = 16;
const SEARCH_K = 10;
/** all-MiniLM-L6-v2 cosine: ~0.3+ is usually related, ~0 is unrelated. */
const MIN_SENTENCE_SIMILARITY = 0.25;
const DEV_MODE_KEY = 'sloth-rag.devMode';

type Stage = 'queued' | 'parsing' | 'tables' | 'embedding' | 'saving' | 'ready' | 'warn' | 'error';
type MobileTab = 'library' | 'ask' | 'source';

/** Import progress for a file added in this session. */
interface ImportState {
  name: string;
  stage: Stage;
  progress?: string;
  details: string[];
  ms?: number;
}

/** A row in the library: an indexed document and/or a file being imported. */
export interface LibraryItem {
  name: string;
  ext: string;
  stage: Stage;
  progress?: string;
  details: string[];
  chunks?: number;
  chars?: number;
  ms?: number;
  indexed: boolean;
}

export interface DisplayHit extends SearchHit {
  segments: Segment[];
  sentenceScore?: number;
}

interface DisplayChunk extends ChunkRow {
  gradient: string;
  preview: string;
}

const ACTIVE: Stage[] = ['queued', 'parsing', 'tables', 'embedding', 'saving'];

@Component({
  selector: 'app-sloth-rag',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './sloth-rag.html',
  host: {
    class: 'block',
    '(dragenter)': 'onDragEnter($event)',
    '(dragover)': '$event.preventDefault()',
    '(dragleave)': 'onDragLeave()',
    '(drop)': 'onDrop($event)',
  },
})
export class SlothRag {
  #parser = inject(DocumentParserService);
  #embedder = inject(EmbeddingService);
  #store = inject(SqliteStoreService);
  #duck = inject(DuckDbService);
  #injector = inject(Injector);

  readonly accept = SUPPORTED_EXTENSIONS.map(e => '.' + e).join(',');
  readonly storage = this.#store.state;
  readonly modelProgress = this.#embedder.downloadProgress;
  /** Another tab owns the database: searching would just hang. */
  readonly paused = computed(() => this.storage() === 'waiting' || this.storage() === 'moved');

  // Library
  documents = signal<DocumentSummary[]>([]);
  imports = signal<Record<string, ImportState>>({});
  library = computed(() => buildLibrary(this.documents(), this.imports()));
  indexing = computed(() => this.library().some(i => ACTIVE.includes(i.stage)));
  chunkCount = computed(() => this.documents().reduce((n, d) => n + d.chunks, 0));
  notice = signal('');
  confirmClear = signal(false);

  // Ask
  query = signal('');
  results = signal<DisplayHit[]>([]);
  searched = signal(false);
  searching = signal(false);
  showWeak = signal(false);
  strongGroups = computed(() => groupHits(this.results().filter(isStrongHit)));
  weakGroups = computed(() => groupHits(this.results().filter(h => !isStrongHit(h))));
  weakCount = computed(() => this.results().filter(h => !isStrongHit(h)).length);

  // Inspector
  selectedDoc = signal<string | undefined>(undefined);
  selectedHit = signal<DisplayHit | undefined>(undefined);
  inspectorTab = signal<'text' | 'table'>('text');
  docChunks = signal<DisplayChunk[]>([]);
  extracted = signal<Record<string, ExtractedDocument>>({});
  docTables = signal<Record<string, string[]>>({});
  selectedTable = signal<string | undefined>(undefined);
  sql = signal('');
  sqlResult = signal<SqlResult | undefined>(undefined);
  sqlRunning = signal(false);
  selectedItem = computed(() => this.library().find(i => i.name === this.selectedDoc()));
  selectedTables = computed(() => this.docTables()[this.selectedDoc() ?? ''] ?? []);

  // Chrome
  devMode = signal(readDevMode());
  mobileTab = signal<MobileTab>('ask');
  dragging = signal(false);
  errors = signal<string[]>([]);

  #queue: File[] = [];
  #processing = false;
  #dragDepth = 0;
  #clearTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.#store.storage().catch(e => this.#error('SQLite', e));
    this.#refreshIndex();
  }

  // ---------- Adding files ----------

  onFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    this.enqueue(Array.from(input.files ?? []));
    input.value = ''; // allow re-selecting the same file
  }

  onDragEnter(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    this.#dragDepth++;
    this.dragging.set(true);
  }

  onDragLeave() {
    if (--this.#dragDepth <= 0) {
      this.#dragDepth = 0;
      this.dragging.set(false);
    }
  }

  async onDrop(e: DragEvent) {
    e.preventDefault();
    this.#dragDepth = 0;
    this.dragging.set(false);
    if (!e.dataTransfer) return;
    const { files, skipped } = await filesFromDrop(e.dataTransfer);
    this.notice.set(skipped ? `Skipped ${skipped} unsupported file(s) from the folder.` : '');
    this.enqueue(files);
  }

  enqueue(files: File[]) {
    if (!files.length) return;
    this.imports.update(all => {
      const next = { ...all };
      for (const f of files) next[f.name] = { name: f.name, stage: 'queued', details: [] };
      return next;
    });
    this.#queue.push(...files);
    if (!this.#processing) this.#processQueue();
  }

  async #processQueue() {
    this.#processing = true;
    while (this.#queue.length) {
      await this.#import(this.#queue.shift()!);
      await this.#refreshIndex();
    }
    this.#processing = false;
  }

  /** Parse → (DuckDB for spreadsheets) → chunk → embed → SQLite. Never throws; records the outcome. */
  async #import(file: File) {
    const name = file.name;
    const start = performance.now();
    const details: string[] = [];
    let stage: Stage = 'ready';
    const warn = (msg: string) => { stage = 'warn'; details.push(msg); };

    try {
      this.#setImport(name, { stage: 'parsing', progress: 'Reading…' });
      const doc = await this.#parser.parse(file);
      this.extracted.update(x => ({ ...x, [name]: doc }));

      if (doc.sheets) {
        this.#setImport(name, { stage: 'tables', progress: 'Loading tables (first time downloads ~34MB)…' });
        const failures = await this.#loadSheets(doc);
        failures.forEach(warn);
      }

      if (!doc.text.trim()) {
        warn(`No text found${doc.type === 'pdf' ? ' (scanned or image-only PDF?)' : ''}, nothing indexed`);
      } else {
        await this.#index(doc);
      }
    } catch (e) {
      stage = 'error';
      details.push(message(e));
      console.error(`[sloth-rag] import failed for ${name}`, e);
    }
    this.#setImport(name, { stage, progress: undefined, details, ms: Math.round(performance.now() - start) });
  }

  async #index(doc: ExtractedDocument) {
    const chunks = chunkText(doc.text);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      this.#setImport(doc.name, { stage: 'embedding', progress: `Embedding ${i}/${chunks.length} passages…` });
      vectors.push(...await this.#embedder.embed(chunks.slice(i, i + EMBED_BATCH)));
    }
    this.#setImport(doc.name, { stage: 'saving', progress: 'Saving…' });
    await this.#store.replaceDocument(doc.name, chunks.map((text, index) => ({ index, text, vector: vectors[index] })));
  }

  /** Returns warnings for sheets that couldn't be loaded. */
  async #loadSheets(doc: ExtractedDocument): Promise<string[]> {
    const isCsv = doc.name.toLowerCase().endsWith('.csv');
    const failures: string[] = [];
    const tables: string[] = [];
    for (const sheet of doc.sheets!) {
      const label = isCsv ? 'CSV' : `Sheet "${sheet.name}"`;
      if (!sheet.csv.trim()) {
        failures.push(`${label} is empty, skipped`);
        continue;
      }
      const table = toTableName(doc.name, isCsv ? undefined : sheet.name);
      try {
        await this.#duck.loadCsv(table, sheet.csv);
        tables.push(table);
      } catch (e) {
        failures.push(`${label} couldn't be loaded as a table: ${message(e)}`);
      }
    }
    this.docTables.update(t => ({ ...t, [doc.name]: tables }));
    return failures;
  }

  #setImport(name: string, patch: Partial<ImportState>) {
    this.imports.update(all => ({ ...all, [name]: { ...(all[name] ?? { name, details: [], stage: 'queued' }), ...patch } }));
  }

  // ---------- Library actions ----------

  async removeDocument(name: string) {
    try {
      await this.#store.deleteDocument(name);
      await this.#duck.dropTables(this.docTables()[name] ?? []);
    } catch (e) {
      this.#error(`Remove ${name}`, e);
    }
    this.imports.update(({ [name]: _, ...rest }) => rest);
    this.extracted.update(({ [name]: _, ...rest }) => rest);
    this.docTables.update(({ [name]: _, ...rest }) => rest);
    this.results.update(r => r.filter(h => h.docName !== name));
    if (this.selectedDoc() === name) this.closeInspector();
    await this.#refreshIndex();
  }

  /** Two-click confirm (no browser dialog): first click arms it for 4 seconds. */
  async clearAll() {
    if (!this.confirmClear()) {
      this.confirmClear.set(true);
      this.#clearTimer = setTimeout(() => this.confirmClear.set(false), 4000);
      return;
    }
    clearTimeout(this.#clearTimer);
    this.confirmClear.set(false);
    try {
      await this.#store.clear();
      await this.#duck.dropTables(Object.values(this.docTables()).flat());
    } catch (e) {
      this.#error('Clear', e);
    }
    this.imports.set({});
    this.extracted.set({});
    this.docTables.set({});
    this.results.set([]);
    this.searched.set(false);
    this.closeInspector();
    await this.#refreshIndex();
  }

  async useHere() {
    try {
      await this.#store.takeOver();
      await this.#refreshIndex();
    } catch (e) {
      this.#error('Storage', e);
    }
  }

  dismissImport(name: string) {
    this.imports.update(({ [name]: _, ...rest }) => rest);
  }

  toggleDevMode() {
    this.devMode.update(v => !v);
    try { localStorage.setItem(DEV_MODE_KEY, String(this.devMode())); } catch { /* storage blocked: session only */ }
  }

  // ---------- Ask ----------

  async search() {
    const query = this.query().trim();
    if (!query || this.searching()) return;
    this.searching.set(true);
    this.showWeak.set(false);
    try {
      const [vector] = await this.#embedder.embed([query]);
      const hits = await this.#store.search(query, vector, SEARCH_K);

      // Semantic highlight: embed each sentence of each strong hit, mark the one closest to the query.
      // Weak hits are skipped: embedding runs on the main thread, and ~10 sentences per hit adds up fast.
      const sentences = hits.map(h => isStrongHit(h) ? splitSentences(h.text) : []);
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
      this.searched.set(true);
    } catch (e) {
      this.#error('Search', e);
    }
    this.searching.set(false);
  }

  // ---------- Inspector ----------

  async openHit(hit: DisplayHit) {
    this.selectedHit.set(hit);
    this.inspectorTab.set('text');
    await this.#selectDoc(hit.docName);
    this.mobileTab.set('source');
    afterNextRender(() => document.getElementById(`chunk-${hit.id}`)?.scrollIntoView({ block: 'center' }),
      { injector: this.#injector });
  }

  async openDocument(name: string) {
    if (this.selectedDoc() === name && !this.selectedHit()) {
      this.closeInspector();
      return;
    }
    this.selectedHit.set(undefined);
    const tables = this.docTables()[name] ?? [];
    this.inspectorTab.set(tables.length ? 'table' : 'text');
    await this.#selectDoc(name);
    if (tables.length) await this.previewTable(tables[0]);
    this.mobileTab.set('source');
  }

  closeInspector() {
    this.selectedDoc.set(undefined);
    this.selectedHit.set(undefined);
    this.docChunks.set([]);
    this.sqlResult.set(undefined);
    this.selectedTable.set(undefined);
  }

  async previewTable(table: string) {
    this.selectedTable.set(table);
    this.sql.set(`SELECT * FROM "${table}" LIMIT 100`);
    await this.runSql();
  }

  async runSql() {
    if (!this.sql().trim()) return;
    this.sqlRunning.set(true);
    try {
      this.sqlResult.set(await this.#duck.query(this.sql()));
    } catch (e) {
      this.#error('SQL', e);
    }
    this.sqlRunning.set(false);
  }

  async #selectDoc(name: string) {
    if (this.selectedDoc() === name && this.docChunks().length) return;
    this.selectedDoc.set(name);
    this.sqlResult.set(undefined);
    this.selectedTable.set(undefined);
    this.docChunks.set([]);
    const item = this.library().find(i => i.name === name);
    if (!item?.indexed) return;
    try {
      const rows = await this.#store.chunks(name);
      this.docChunks.set(rows.map(r => ({
        ...r,
        gradient: vectorGradient(r.vector),
        preview: Array.from(r.vector.slice(0, 4), x => x.toFixed(3)).join(', ') + ', …',
      })));
    } catch (e) {
      this.#error(`Load ${name}`, e);
    }
  }

  // ---------- Helpers ----------

  async #refreshIndex() {
    try {
      this.documents.set(await this.#store.documents());
    } catch (e) {
      if (this.storage() !== 'moved') this.#error('SQLite', e);
    }
  }

  #error(context: string, e: unknown) {
    console.error(`[sloth-rag] ${context}`, e);
    this.errors.update(errs => [...errs, `${context}: ${message(e)}`]);
  }
}

/** Merge what's in SQLite with what's being imported this session, sorted by name. */
export function buildLibrary(documents: DocumentSummary[], imports: Record<string, ImportState>): LibraryItem[] {
  const byName = new Map<string, LibraryItem>();
  for (const d of documents) {
    byName.set(d.docName, {
      name: d.docName, ext: fileExtension(d.docName), stage: 'ready', details: [],
      chunks: d.chunks, chars: d.chars, indexed: true,
    });
  }
  for (const imp of Object.values(imports)) {
    const indexed = byName.get(imp.name);
    byName.set(imp.name, {
      ...indexed, name: imp.name, ext: fileExtension(imp.name), indexed: !!indexed,
      stage: imp.stage, progress: imp.progress, details: imp.details, ms: imp.ms,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Collect files from a drop, walking dropped folders. Unsupported files inside folders are skipped. */
async function filesFromDrop(dt: DataTransfer): Promise<{ files: File[]; skipped: number }> {
  // Entries must be read synchronously, before the DataTransfer is cleared at the end of the event.
  const entries = Array.from(dt.items, i => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return { files: Array.from(dt.files), skipped: 0 };

  const files: File[] = [];
  let skipped = 0;
  const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
  const walk = async (entry: FileSystemEntry, inFolder: boolean): Promise<void> => {
    if (entry.isFile) {
      const file = await fileOf(entry as FileSystemFileEntry);
      if (!inFolder || SUPPORTED_EXTENSIONS.includes(fileExtension(file.name))) files.push(file);
      else skipped++;
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches; keep reading until it returns none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child, true);
    }
  };
  for (const entry of entries) await walk(entry, false);
  return { files, skipped };
}

function readDevMode(): boolean {
  try { return localStorage.getItem(DEV_MODE_KEY) === 'true'; } catch { return false; }
}

function message(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}
