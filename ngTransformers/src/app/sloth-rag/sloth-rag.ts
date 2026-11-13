import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DocumentParserService, ExtractedDocument } from './document-parser.service';

@Component({
  selector: 'app-sloth-rag',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <h1>🦥 Sloth RAG</h1>
    <p>Slow, in-browser document parsing. Nothing leaves your machine.</p>

    <input type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.csv" (change)="onFiles($event)" />

    @if (busy()) { <p>Parsing... (slowly)</p> }

    @for (err of errors(); track $index) {
      <p style="color: red">{{ err }}</p>
    }

    @for (doc of docs(); track doc.name) {
      <details open>
        <summary>{{ doc.name }} ({{ doc.type }}, {{ doc.text.length }} chars, {{ doc.ms }} ms)</summary>
        <pre style="white-space: pre-wrap; max-height: 400px; overflow: auto">{{ doc.text }}</pre>
      </details>
    }
  `
})
export class SlothRag {
  #parser = inject(DocumentParserService);

  docs = signal<ExtractedDocument[]>([]);
  errors = signal<string[]>([]);
  busy = signal(false);

  async onFiles(event: Event) {
    const files = Array.from((event.target as HTMLInputElement).files ?? []);
    this.busy.set(true);
    for (const file of files) {
      try {
        const doc = await this.#parser.parse(file);
        this.docs.update(d => [...d, doc]);
      } catch (e: any) {
        this.errors.update(errs => [...errs, `${file.name}: ${e?.message ?? e}`]);
      }
    }
    this.busy.set(false);
  }
}
