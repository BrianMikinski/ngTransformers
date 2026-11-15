import {
  Component, ChangeDetectionStrategy, ElementRef, Injector, afterNextRender, computed, inject, signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DocumentParserService, ExtractedDocument, SUPPORTED_EXTENSIONS } from './document-parser.service';
import { EmbeddingService } from './embedding.service';
import { SqliteStoreService } from './sqlite-store.service';
import { DuckDbService, SqlResult } from './duckdb.service';
import { GenerateResult, LLM_MODELS, LlmService } from './llm.service';
import {
  ChatMessage, SQL_PREFIX, TableSchema, answerMessages, extractSql, fixGroupBy, isNotFound, isReadOnlySql, parseAnswer, buildSources, answerCandidates,
  sqlMessages, sqlRepairMessages,
} from './answer-utils';
import {
  ChunkRow, DocumentSummary, SearchHit, Segment, Span, StoredDocument,
  chunkSpans, dot, fileExtension, groupHits, highlightSegments, isStrongHit, queryTerms, splitSentences,
  toTableName, vectorGradient,
} from './rag-utils';
import { LineKind, ViewSheet, compactSheet, documentLines, sectionLabel, sections, sheetTables } from './document-view';

const EMBED_BATCH = 16;
const SEARCH_K = 10;
/** all-MiniLM-L6-v2 cosine: ~0.3+ is usually related, ~0 is unrelated. */
const MIN_SENTENCE_SIMILARITY = 0.25;
const DEV_MODE_KEY = 'sloth-rag.devMode';
const SHEET_EXTENSIONS = ['xlsx', 'xls', 'csv'];
/** Shipped in public/samples. */
const SAMPLES = ['employee-handbook.pdf', 'kestrel-status.md', 'offsite-notes.docx', 'q3-sales.xlsx', 'sloth-facts.txt'];

type Stage = 'queued' | 'parsing' | 'embedding' | 'saving' | 'ready' | 'warn' | 'error';
type MobileTab = 'library' | 'ask' | 'source';
type InspectorTab = 'document' | 'sql' | 'passages';

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
  hasText: boolean;
}

export interface DisplayHit extends SearchHit {
  segments: Segment[];
  sentenceScore?: number;
  /** Spreadsheet hits render as small tables instead of CSV text. */
  sheets?: ViewSheet[];
}

/** The written answer for the last search. */
interface AnswerState {
  question: string;
  /** Passages given to the model; citation [n] is sources[n - 1]. */
  sources: DisplayHit[];
  /** Result id -> citation number, including passages merged into a source. */
  numbers: Map<number, number>;
  text: string;
  startedAt: number;
  status: 'waiting' | 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
  stats?: GenerateResult;
}

interface DisplayChunk extends ChunkRow {
  gradient: string;
  preview: string;
}

const ACTIVE: Stage[] = ['queued', 'parsing', 'embedding', 'saving'];

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
  readonly llm = inject(LlmService);
  readonly llmModels = LLM_MODELS;
  #injector = inject(Injector);
  #host = inject<ElementRef<HTMLElement>>(ElementRef);

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
  samplesLoading = signal(false);

  // Ask
  query = signal('');
  terms = signal<string[]>([]);
  results = signal<DisplayHit[]>([]);
  searched = signal(false);
  searching = signal(false);
  showWeak = signal(false);
  strongGroups = computed(() => groupHits(this.results().filter(isStrongHit)));
  weakGroups = computed(() => groupHits(this.results().filter(h => !isStrongHit(h))));
  weakCount = computed(() => this.results().filter(h => !isStrongHit(h)).length);
  /** The question the current results (and answer) are for. */
  askedQuery = signal('');

  // Answer (RAG)
  answer = signal<AnswerState | undefined>(undefined);
  answerParts = computed(() => {
    const a = this.answer();
    return a ? parseAnswer(a.text, a.sources.length) : [];
  });
  answerNotFound = computed(() => this.answer()?.status === 'done' && isNotFound(this.answer()!.text));
  answerActive = computed(() => ['waiting', 'streaming'].includes(this.answer()?.status ?? ''));
  now = signal(Date.now());
  answerSeconds = computed(() => Math.max(0, Math.round((this.now() - (this.answer()?.startedAt ?? this.now())) / 1000)));
  sqlStartedAt = signal(0);
  sqlSeconds = computed(() => Math.max(0, Math.round((this.now() - this.sqlStartedAt()) / 1000)));
  /** Result id -> its citation number, so result cards show which [n] they are. */
  sourceNumbers = computed(() => this.answer()?.numbers ?? new Map<number, number>());
  /** A spreadsheet among the strong results: offer to answer with SQL instead (numbers need real arithmetic). */
  sheetResult = computed(() => this.strongGroups().find(g => SHEET_EXTENSIONS.includes(fileExtension(g.docName)))?.docName);

  // Inspector
  selectedDoc = signal<string | undefined>(undefined);
  selectedHit = signal<DisplayHit | undefined>(undefined);
  inspectorTab = signal<InspectorTab>('document');
  storedDoc = signal<StoredDocument | undefined>(undefined);
  docLoading = signal(false);
  docChunks = signal<DisplayChunk[]>([]);
  docTables = signal<Record<string, string[]>>({});
  tablesLoading = signal(false);
  selectedTable = signal<string | undefined>(undefined);
  sql = signal('');
  sqlResult = signal<SqlResult | undefined>(undefined);
  sqlRunning = signal(false);
  sqlError = signal('');
  /** Natural language -> SQL. */
  sqlQuestion = signal('');
  sqlWriting = signal(false);
  sqlNote = signal('');
  selectedItem = computed(() => this.library().find(i => i.name === this.selectedDoc()));
  selectedTables = computed(() => this.docTables()[this.selectedDoc() ?? ''] ?? []);
  isSheet = computed(() => SHEET_EXTENSIONS.includes(this.selectedItem()?.ext ?? ''));
  /** The selected hit, positioned in the stored document (legacy rows have no offsets). */
  highlight = computed(() => {
    const hit = this.selectedHit(), doc = this.storedDoc();
    if (!hit || !doc || hit.docName !== doc.name || hit.start === undefined || hit.end === undefined) return undefined;
    return { start: hit.start, end: hit.end, segments: hit.segments };
  });
  viewLines = computed(() => {
    const doc = this.storedDoc();
    if (!doc || this.isSheet()) return [];
    return documentLines(doc.text, { markdown: doc.type === 'markdown', highlight: this.highlight() });
  });
  viewSheets = computed(() => {
    const doc = this.storedDoc();
    if (!doc || !this.isSheet()) return [];
    return sheetTables(doc.text, { terms: this.selectedHit() ? this.terms() : [], hit: this.highlight() });
  });

  /** Light document styling per line kind (Markdown headings, lists, quotes, code; PDF pages). */
  readonly lineClass: Record<LineKind, string> = {
    section: 'mt-6 mb-2 border-b border-line pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase first:mt-0',
    h1: 'mt-4 mb-1 text-xl font-semibold whitespace-pre-wrap',
    h2: 'mt-3 mb-1 text-lg font-semibold whitespace-pre-wrap',
    h3: 'mt-2 font-semibold whitespace-pre-wrap',
    li: 'pl-4 -indent-4 whitespace-pre-wrap',
    quote: 'border-l-2 border-line pl-3 text-muted whitespace-pre-wrap',
    code: 'bg-surface px-3 font-mono text-xs whitespace-pre',
    hr: 'text-subtle',
    p: 'whitespace-pre-wrap',
    blank: 'h-3',
  };

  // Chrome
  devMode = signal(readDevMode());
  mobileTab = signal<MobileTab>('ask');
  dragging = signal(false);
  errors = signal<string[]>([]);

  #queue: File[] = [];
  #processing = false;
  #dragDepth = 0;
  #clearTimer?: ReturnType<typeof setTimeout>;
  #answerRun = 0;

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

  /** Fetch the bundled sample documents and import them like dropped files. */
  async loadSamples() {
    this.samplesLoading.set(true);
    try {
      const files = await Promise.all(SAMPLES.map(async name => {
        const res = await fetch(new URL(`samples/${name}`, document.baseURI));
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        return new File([await res.blob()], name);
      }));
      this.enqueue(files);
    } catch (e) {
      this.#error('Sample documents', e);
    }
    this.samplesLoading.set(false);
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

  /** Parse → chunk → embed → SQLite (text + passages). Never throws; records the outcome. */
  async #import(file: File) {
    const name = file.name;
    const start = performance.now();
    const details: string[] = [];
    let stage: Stage = 'ready';
    const warn = (msg: string) => { stage = 'warn'; details.push(msg); };

    try {
      this.#setImport(name, { stage: 'parsing', progress: 'Reading…' });
      const doc = await this.#parser.parse(file);

      for (const sheet of doc.sheets ?? []) {
        if (!sheet.csv.trim()) warn(`Sheet "${sheet.name}" is empty`);
      }
      // Re-added spreadsheet: drop stale DuckDB tables so SQL reloads the new data.
      await this.#dropTables(name);

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
    if (this.selectedDoc() === name) this.#reloadInspector(name);
  }

  async #index(doc: ExtractedDocument) {
    const spans = chunkSpans(doc.text);
    const secs = sections(doc.text);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < spans.length; i += EMBED_BATCH) {
      this.#setImport(doc.name, { stage: 'embedding', progress: `Embedding ${i}/${spans.length} passages…` });
      vectors.push(...await this.#embedder.embed(spans.slice(i, i + EMBED_BATCH).map(s => s.text)));
    }
    this.#setImport(doc.name, { stage: 'saving', progress: 'Saving…' });
    await this.#store.replaceDocument(
      { name: doc.name, type: doc.type, text: doc.text, sheets: doc.sheets },
      spans.map((s, index) => ({ ...s, index, section: sectionLabel(secs, s.start, s.end), vector: vectors[index] })),
    );
  }

  #setImport(name: string, patch: Partial<ImportState>) {
    this.imports.update(all => ({ ...all, [name]: { ...(all[name] ?? { name, details: [], stage: 'queued' }), ...patch } }));
  }

  // ---------- Library actions ----------

  async removeDocument(name: string) {
    try {
      await this.#store.deleteDocument(name);
      await this.#dropTables(name);
    } catch (e) {
      this.#error(`Remove ${name}`, e);
    }
    this.imports.update(({ [name]: _, ...rest }) => rest);
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
    this.docTables.set({});
    this.results.set([]);
    this.searched.set(false);
    this.#clearAnswer();
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
    if (!this.devMode() && this.inspectorTab() === 'passages') this.inspectorTab.set('document');
  }

  // ---------- Ask ----------

  async search() {
    const query = this.query().trim();
    if (!query || this.searching()) return;
    this.searching.set(true);
    this.showWeak.set(false);
    this.#clearAnswer();
    try {
      const [vector] = await this.#embedder.embed([query]);
      const hits = await this.#store.search(query, vector, SEARCH_K);
      const isSheet = (h: SearchHit) => SHEET_EXTENSIONS.includes(fileExtension(h.docName));

      // Semantic highlight: embed each sentence of each strong text hit, mark the one closest to the query.
      // (Sentences mean nothing in CSV, and weak hits aren't worth the time.)
      const sentences = hits.map(h => isStrongHit(h) && !isSheet(h) ? splitSentences(h.text) : []);
      const toEmbed = sentences.flatMap((ss, i) => ss.length > 1 ? ss.map(s => hits[i].text.slice(s.start, s.end)) : []);
      const sentenceVectors = await this.#embedder.embed(toEmbed);

      const terms = queryTerms(query);
      this.terms.set(terms);
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
        return {
          ...hit,
          segments: highlightSegments(hit.text, terms, semantic),
          sentenceScore: best?.score,
          sheets: isSheet(hit) ? sheetTables(hit.text, { terms, header: false }).map(t => compactSheet(t)) : undefined,
        };
      }));
      this.askedQuery.set(query);
      this.searched.set(true);
    } catch (e) {
      this.#error('Search', e);
    }
    this.searching.set(false);
    if (this.searched() && this.llm.enabled()) this.generateAnswer();
  }

  // ---------- Answer (RAG) ----------

  /** The user opted in to the model download: answer the current results right away. */
  enableAnswers() {
    this.llm.enable();
    if (this.searched()) this.generateAnswer();
  }

  setModel(id: string) {
    this.llm.setModel(id);
    if (this.answer()) this.generateAnswer();
  }

  /** Written answer from the strong results, streamed in, with [n] citations to them. */
  async generateAnswer() {
    const question = this.askedQuery();
    const strong = this.results().filter(isStrongHit);
    const candidates = answerCandidates(strong);
    const built = buildSources(candidates.length ? candidates : strong.slice(0, 1));
    const sources = built.map(s => s.hit);
    if (!question || !sources.length) {
      this.answer.set(undefined);
      return;
    }
    const run = ++this.#answerRun;
    const current = () => run === this.#answerRun;
    const numbers = new Map(built.flatMap((s, i) => s.hits.map(h => [h.id, i + 1] as const)));
    this.answer.set({ question, sources, numbers, text: '', status: 'waiting', startedAt: Date.now() });
    // Reading the passages can take a while on slow GPUs: tick a seconds counter so it visibly progresses.
    const ticker = setInterval(() => this.now.set(Date.now()), 1000);
    try {
      const stats = await this.llm.generate(
        answerMessages(question, built),
        {
          maxNewTokens: 240,
          onToken: t => current() && this.answer.update(a => a && { ...a, text: a.text + t, status: 'streaming' }),
        },
      );
      if (current()) {
        this.answer.update(a => a && { ...a, text: stats.text.trim(), status: stats.interrupted ? 'stopped' : 'done', stats });
      }
    } catch (e) {
      if (current()) this.answer.update(a => a && { ...a, status: 'error', error: message(e) });
    } finally {
      clearInterval(ticker);
    }
  }

  stopAnswer() {
    this.llm.stop();
  }

  openSource(n: number) {
    const hit = this.answer()?.sources[n - 1];
    if (hit) this.openHit(hit);
  }

  #clearAnswer() {
    this.#answerRun++;
    if (this.answerActive()) this.llm.stop();
    this.answer.set(undefined);
  }

  /** From the Ask pane: answer the question with SQL over a spreadsheet in the results. */
  async askWithSql(docName: string) {
    this.sqlQuestion.set(this.askedQuery());
    this.selectedHit.set(undefined);
    this.mobileTab.set('source');
    await this.#selectDoc(docName);
    await this.setTab('sql');
    await this.writeSql();
  }

  // ---------- Inspector ----------

  async openHit(hit: DisplayHit) {
    this.selectedHit.set(hit);
    if (this.inspectorTab() === 'sql') this.inspectorTab.set('document');
    this.mobileTab.set('source');
    await this.#selectDoc(hit.docName);
    this.#scrollToHit();
  }

  async openDocument(name: string) {
    if (this.selectedDoc() === name && !this.selectedHit()) {
      this.closeInspector();
      return;
    }
    this.selectedHit.set(undefined);
    this.inspectorTab.set('document');
    this.mobileTab.set('source');
    await this.#selectDoc(name);
    this.#host.nativeElement.querySelector('#inspector')?.scrollTo({ top: 0 });
  }

  closeInspector() {
    this.selectedDoc.set(undefined);
    this.selectedHit.set(undefined);
    this.storedDoc.set(undefined);
    this.docChunks.set([]);
    this.sqlResult.set(undefined);
    this.sqlError.set('');
    this.sqlNote.set('');
    this.selectedTable.set(undefined);
  }

  async setTab(tab: InspectorTab) {
    this.inspectorTab.set(tab);
    const name = this.selectedDoc();
    if (!name) return;
    if (tab === 'sql') await this.#ensureTables(name);
    if (tab === 'passages') await this.#loadChunks(name);
    if (tab === 'document' && this.highlight()) this.#scrollToHit();
  }

  async previewTable(table: string) {
    this.selectedTable.set(table);
    this.sql.set(`SELECT * FROM "${table}" LIMIT 100`);
    await this.runSql();
  }

  async runSql() {
    if (!this.sql().trim()) return;
    this.sqlNote.set('');
    await this.#runSql().catch(() => undefined); // the error is shown under the editor
  }

  /** Runs the editor's SQL; errors are shown under the editor (sqlError) and rethrown. */
  async #runSql() {
    this.sqlRunning.set(true);
    this.sqlError.set('');
    try {
      this.sqlResult.set(await this.#duck.query(this.sql()));
    } catch (e) {
      this.sqlResult.set(undefined);
      this.sqlError.set(message(e));
      throw e;
    } finally {
      this.sqlRunning.set(false);
    }
  }

  /**
   * Natural language -> SQL with the answer model, using the selected spreadsheet's tables (columns plus
   * a few example rows). The SQL lands in the editor, runs if it only reads, and gets one repair attempt
   * if DuckDB rejects it.
   */
  async writeSql() {
    const question = this.sqlQuestion().trim();
    const name = this.selectedDoc();
    if (!question || !name || this.sqlWriting()) return;
    this.sqlWriting.set(true);
    this.sqlStartedAt.set(Date.now());
    this.now.set(Date.now());
    const ticker = setInterval(() => this.now.set(Date.now()), 1000);
    this.sqlNote.set('');
    this.sqlError.set('');
    try {
      await this.#ensureTables(name);
      const tables = this.docTables()[name] ?? [];
      if (!tables.length) throw new Error('No tables to query: add the spreadsheet again.');
      const schemas: TableSchema[] = await Promise.all(tables.map(async table => ({
        table,
        columns: await this.#duck.columns(table),
        sample: (await this.#duck.query(`SELECT * FROM "${table}" LIMIT 3`)).rows,
      })));

      let messages = sqlMessages(question, schemas);
      let sql = await this.#writeSqlOnce(messages);
      if (!sql) return;
      if (!isReadOnlySql(sql)) {
        this.sqlNote.set('Not run automatically: only SELECT queries run on their own. Check it, then press Run SQL.');
        return;
      }
      const check = ' Check it before trusting the numbers.';
      if (await this.#tryRun(sql, question)) {
        this.sqlNote.set(`SQL written by the AI model${this.#autoFixed ? ', with a GROUP BY mistake fixed automatically' : ''}.${check}`);
        return;
      }
      // Small models often get a column name or function wrong: show it the error and try once more.
      messages = sqlRepairMessages(messages, sql, this.sqlError());
      sql = await this.#writeSqlOnce(messages);
      if (!sql || !isReadOnlySql(sql)) return;
      this.sqlNote.set(await this.#tryRun(sql, question)
        ? `SQL written by the AI model (second try, after an error).${check}`
        : 'The AI model could not write a working query. Try rephrasing, or edit the SQL.');
    } catch (e) {
      this.#error('Write SQL', e);
    } finally {
      this.sqlWriting.set(false);
      clearInterval(ticker);
    }
  }

  stopSql() {
    this.llm.stop();
  }

  #autoFixed = false;

  /** Runs `sql`; if DuckDB rejects it for the classic GROUP BY mistake, fixes that in code and runs again. */
  async #tryRun(sql: string, question: string): Promise<boolean> {
    this.#autoFixed = false;
    this.sql.set(sql);
    try {
      await this.#runSql();
      return true;
    } catch (e) {
      const fixed = fixGroupBy(sql, message(e), question);
      if (!fixed) return false;
      this.sql.set(fixed);
      this.#autoFixed = true;
      return this.#runSql().then(() => true, () => false);
    }
  }

  /** Streams the model's SQL into the editor, then cleans it up. Returns '' if it was stopped. */
  async #writeSqlOnce(messages: ChatMessage[]): Promise<string> {
    this.sql.set('');
    this.sqlResult.set(undefined);
    this.sqlError.set('');
    let raw = '';
    const result = await this.llm.generate(messages, {
      maxNewTokens: 200,
      prefix: SQL_PREFIX,
      onToken: t => this.sql.set(extractSql(raw += t)),
    });
    const sql = extractSql(result.text);
    this.sql.set(sql);
    return result.interrupted ? '' : sql;
  }

  async #selectDoc(name: string) {
    if (this.selectedDoc() === name && (this.storedDoc() || this.docChunks().length)) return;
    this.selectedDoc.set(name);
    this.storedDoc.set(undefined);
    this.docChunks.set([]);
    this.sqlResult.set(undefined);
    this.sqlError.set('');
    this.sqlNote.set('');
    this.selectedTable.set(undefined);
    await this.#reloadInspector(name);
  }

  /** Loads the stored document; documents indexed before full-text storage fall back to passages. */
  async #reloadInspector(name: string) {
    const item = this.library().find(i => i.name === name);
    if (!item?.indexed) return;
    this.docLoading.set(true);
    try {
      const doc = await this.#store.document(name);
      if (this.selectedDoc() !== name) return;
      this.storedDoc.set(doc);
      if (!doc || this.inspectorTab() === 'passages') await this.#loadChunks(name);
      if (this.inspectorTab() === 'sql') await this.#ensureTables(name);
    } catch (e) {
      this.#error(`Load ${name}`, e);
    } finally {
      this.docLoading.set(false);
    }
  }

  async #loadChunks(name: string) {
    if (this.docChunks().length) return;
    try {
      const rows = await this.#store.chunks(name);
      if (this.selectedDoc() !== name) return;
      this.docChunks.set(rows.map(r => ({
        ...r,
        gradient: vectorGradient(r.vector),
        preview: Array.from(r.vector.slice(0, 4), x => x.toFixed(3)).join(', ') + ', …',
      })));
    } catch (e) {
      this.#error(`Load ${name}`, e);
    }
  }

  /** DuckDB tables are in-memory, so they're (re)built from the stored sheets the first time SQL is opened. */
  async #ensureTables(name: string) {
    if (!this.docTables()[name]) {
      const sheets = (this.storedDoc() ?? await this.#store.document(name))?.sheets;
      if (!sheets) return; // indexed before sheets were stored
      this.tablesLoading.set(true);
      try {
        const isCsv = name.toLowerCase().endsWith('.csv');
        const tables: string[] = [];
        for (const sheet of sheets.filter(s => s.csv.trim())) {
          const table = toTableName(name, isCsv ? undefined : sheet.name);
          await this.#duck.loadCsv(table, sheet.csv);
          tables.push(table);
        }
        this.docTables.update(t => ({ ...t, [name]: tables }));
      } catch (e) {
        this.#error(`Load tables for ${name}`, e);
      } finally {
        this.tablesLoading.set(false);
      }
    }
    const tables = this.docTables()[name] ?? [];
    if (this.selectedDoc() === name && tables.length && !this.selectedTable()) await this.previewTable(tables[0]);
  }

  async #dropTables(name: string) {
    const tables = this.docTables()[name];
    if (!tables) return;
    await this.#duck.dropTables(tables);
    this.docTables.update(({ [name]: _, ...rest }) => rest);
  }

  #scrollToHit() {
    afterNextRender(
      () => this.#host.nativeElement.querySelector('#inspector [data-hit]')?.scrollIntoView({ block: 'center' }),
      { injector: this.#injector },
    );
  }

  // ---------- Helpers ----------

  async #refreshIndex() {
    try {
      this.documents.set(await this.#store.documents());
    } catch (e) {
      if (this.storage() !== 'moved') this.#error('SQLite', e);
    }
  }

  hasWords(text: string): boolean {
    return /\w/.test(text);
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
      chunks: d.chunks, chars: d.chars, indexed: true, hasText: d.hasText,
    });
  }
  for (const imp of Object.values(imports)) {
    const indexed = byName.get(imp.name);
    byName.set(imp.name, {
      ...indexed, name: imp.name, ext: fileExtension(imp.name), indexed: !!indexed, hasText: !!indexed?.hasText,
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
