import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DocumentParserService, ExtractedDocument } from './document-parser.service';
import { EmbeddingService } from './embedding.service';
import { SqliteStoreService } from './sqlite-store.service';
import { DuckDbService, SqlResult, TableInfo } from './duckdb.service';
import { chunkText, SearchHit, toTableName } from './rag-utils';

const EMBED_BATCH = 16;

@Component({
  selector: 'app-sloth-rag',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <h1>🦥 Sloth RAG</h1>
    <p>Slow, in-browser document parsing and search. Nothing leaves your machine.</p>

    <p>
      Index: {{ chunkCount() }} chunks · {{ storage() }}
      <button (click)="clearIndex()" [disabled]="busy()">Clear index</button>
    </p>

    <input type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.markdown"
           (change)="onFiles($event)" [disabled]="busy()" />

    @if (status()) { <p>{{ status() }}</p> }

    @for (err of errors(); track $index) {
      <p style="color: red">{{ err }}</p>
    }

    <h2>Search <small>(keyword + semantic)</small></h2>
    <input #q size="50" placeholder="Ask something about your documents..."
           (keydown.enter)="search(q.value)" [disabled]="busy()" />
    <button (click)="search(q.value)" [disabled]="busy()">Search</button>

    @for (r of results(); track r.id) {
      <div style="margin: 1em 0">
        <strong>{{ r.score.toFixed(4) }}</strong> · {{ r.docName }} · chunk {{ r.index }}
        <small>
          · semantic {{ r.vectorRank ? '#' + r.vectorRank + ' (' + r.similarity!.toFixed(3) + ')' : '-' }}
          · keyword {{ r.keywordRank ? '#' + r.keywordRank : '-' }}
        </small>
        <pre style="white-space: pre-wrap; margin: 0.25em 0">{{ r.text }}</pre>
      </div>
    }

    <h2>Spreadsheet SQL <small>(DuckDB)</small></h2>
    @if (tables().length) {
      <ul>
        @for (t of tables(); track t.table) { <li><code>{{ t.table }}</code>: {{ t.columns }}</li> }
      </ul>
      <textarea #sql rows="4" cols="80" [value]="'SELECT * FROM ' + tables()[0].table + ' LIMIT 10'"></textarea>
      <br />
      <button (click)="runSql(sql.value)" [disabled]="busy()">Run SQL</button>

      @if (sqlResult(); as r) {
        <p><small>{{ r.total }} rows{{ r.total > r.rows.length ? ' (showing ' + r.rows.length + ')' : '' }}</small></p>
        <div style="overflow: auto; max-height: 400px">
          <table border="1" cellpadding="4" style="border-collapse: collapse">
            <tr>@for (c of r.columns; track $index) { <th>{{ c }}</th> }</tr>
            @for (row of r.rows; track $index) {
              <tr>@for (v of row; track $index) { <td>{{ v }}</td> }</tr>
            }
          </table>
        </div>
      }
    } @else {
      <p>Upload a .xlsx / .xls / .csv to query it with SQL. (Tables are in-memory: re-upload after a reload.)</p>
    }

    @if (docs().length) { <h2>Extracted text</h2> }
    @for (doc of docs(); track doc.name) {
      <details>
        <summary>{{ doc.name }} ({{ doc.type }}, {{ doc.text.length }} chars, {{ doc.ms }} ms)</summary>
        <pre style="white-space: pre-wrap; max-height: 400px; overflow: auto">{{ doc.text }}</pre>
      </details>
    }
  `
})
export class SlothRag {
  #parser = inject(DocumentParserService);
  #embedder = inject(EmbeddingService);
  #store = inject(SqliteStoreService);
  #duck = inject(DuckDbService);

  docs = signal<ExtractedDocument[]>([]);
  errors = signal<string[]>([]);
  results = signal<SearchHit[]>([]);
  tables = signal<TableInfo[]>([]);
  sqlResult = signal<SqlResult | undefined>(undefined);
  chunkCount = signal(0);
  storage = signal('opening SQLite...');
  status = signal('');
  busy = signal(false);

  constructor() {
    this.#store.storage().then(s => this.storage.set(s), e => this.#error('SQLite', e));
    this.#refreshCount();
  }

  async onFiles(event: Event) {
    const files = Array.from((event.target as HTMLInputElement).files ?? []);
    this.busy.set(true);
    for (const file of files) {
      try {
        this.status.set(`Parsing ${file.name}...`);
        const doc = await this.#parser.parse(file);
        this.docs.update(d => [...d.filter(x => x.name !== doc.name), doc]);
        if (doc.sheets) await this.#loadSheets(doc);
        await this.#index(doc);
      } catch (e) {
        this.#error(file.name, e);
      }
    }
    this.status.set('');
    this.busy.set(false);
    await this.#refreshCount();
  }

  async search(query: string) {
    if (!query.trim()) return;
    await this.#run('Searching... (first search may download the embedding model)', async () => {
      const [vector] = await this.#embedder.embed([query]);
      this.results.set(await this.#store.search(query, vector, 5));
    });
  }

  async runSql(sql: string) {
    await this.#run('Running SQL...', async () => this.sqlResult.set(await this.#duck.query(sql)));
  }

  async clearIndex() {
    await this.#store.clear();
    this.results.set([]);
    await this.#refreshCount();
  }

  async #index(doc: ExtractedDocument) {
    const chunks = chunkText(doc.text);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      this.status.set(`Embedding ${doc.name}: ${i}/${chunks.length} chunks (first run downloads the model)...`);
      vectors.push(...await this.#embedder.embed(chunks.slice(i, i + EMBED_BATCH)));
    }
    this.status.set(`Saving ${doc.name} to SQLite...`);
    await this.#store.replaceDocument(doc.name, chunks.map((text, index) => ({ index, text, vector: vectors[index] })));
  }

  async #loadSheets(doc: ExtractedDocument) {
    this.status.set(`Loading ${doc.name} into DuckDB (first time downloads ~34MB)...`);
    const isCsv = doc.name.toLowerCase().endsWith('.csv');
    for (const sheet of doc.sheets!) {
      if (!sheet.csv.trim()) continue; // DuckDB can't infer a schema from an empty sheet
      await this.#duck.loadCsv(toTableName(doc.name, isCsv ? undefined : sheet.name), sheet.csv);
    }
    this.tables.set(await this.#duck.tables());
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

  async #refreshCount() {
    try {
      this.chunkCount.set(await this.#store.count());
    } catch (e) {
      this.#error('SQLite', e);
    }
  }

  #error(context: string, e: unknown) {
    this.errors.update(errs => [...errs, `${context}: ${(e as Error)?.message ?? e}`]);
  }
}
