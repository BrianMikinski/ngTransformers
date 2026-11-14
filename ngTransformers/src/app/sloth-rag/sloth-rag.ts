import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DocumentParserService, ExtractedDocument } from './document-parser.service';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';
import { chunkText, SearchResult, topK } from './rag-utils';

const EMBED_BATCH = 16;

@Component({
  selector: 'app-sloth-rag',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <h1>🦥 Sloth RAG</h1>
    <p>Slow, in-browser document parsing and search. Nothing leaves your machine.</p>

    <p>
      Index: {{ chunkCount() }} chunks saved in IndexedDB
      <button (click)="clearIndex()" [disabled]="busy()">Clear index</button>
    </p>

    <input type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.markdown"
           (change)="onFiles($event)" [disabled]="busy()" />

    @if (status()) { <p>{{ status() }}</p> }

    @for (err of errors(); track $index) {
      <p style="color: red">{{ err }}</p>
    }

    <h2>Search</h2>
    <input #q size="50" placeholder="Ask something about your documents..."
           (keydown.enter)="search(q.value)" [disabled]="busy()" />
    <button (click)="search(q.value)" [disabled]="busy()">Search</button>

    @for (r of results(); track r.id) {
      <div style="margin: 1em 0">
        <strong>{{ r.score.toFixed(3) }}</strong> · {{ r.docName }} · chunk {{ r.index }}
        <pre style="white-space: pre-wrap; margin: 0.25em 0">{{ r.text }}</pre>
      </div>
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
  #store = inject(VectorStoreService);

  docs = signal<ExtractedDocument[]>([]);
  errors = signal<string[]>([]);
  results = signal<SearchResult[]>([]);
  chunkCount = signal(0);
  status = signal('');
  busy = signal(false);

  constructor() {
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
        await this.#index(doc);
      } catch (e: any) {
        this.errors.update(errs => [...errs, `${file.name}: ${e?.message ?? e}`]);
      }
    }
    this.status.set('');
    this.busy.set(false);
    await this.#refreshCount();
  }

  async search(query: string) {
    if (!query.trim()) return;
    this.busy.set(true);
    this.status.set('Searching... (first search may download the embedding model)');
    try {
      const [vector] = await this.#embedder.embed([query]);
      this.results.set(topK(vector, await this.#store.all(), 5));
    } catch (e: any) {
      this.errors.update(errs => [...errs, `Search failed: ${e?.message ?? e}`]);
    }
    this.status.set('');
    this.busy.set(false);
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
    await this.#store.replaceDocument(doc.name, chunks.map((text, index) => ({
      id: `${doc.name}#${index}`, docName: doc.name, index, text, vector: vectors[index]
    })));
  }

  async #refreshCount() {
    this.chunkCount.set(await this.#store.count());
  }
}
