import { Injectable, signal } from '@angular/core';
import { pipeline } from '@huggingface/transformers';

/** Sentence embeddings in the browser. The model (~23MB) downloads on first use, then is browser-cached. */
@Injectable({ providedIn: 'root' })
export class EmbeddingService {
  /** Model download progress 0-100 while downloading, undefined otherwise. */
  readonly downloadProgress = signal<number | undefined>(undefined);

  #extractor?: Promise<any>;
  /** Calls run one at a time: background indexing and searches share one ONNX session. */
  #queue: Promise<unknown> = Promise.resolve();

  embed(texts: string[]): Promise<Float32Array[]> {
    const run = this.#queue.then(async () => {
      const extractor = await this.#load();
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      return (output.tolist() as number[][]).map(v => Float32Array.from(v));
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #load() {
    return this.#extractor ??= (() => {
      const files = new Map<string, { loaded: number; total: number }>();
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        progress_callback: (p: any) => {
          if (p.status !== 'progress' || !p.total) return;
          files.set(p.file, { loaded: p.loaded, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          this.downloadProgress.set(Math.round((loaded / total) * 100));
        },
      }).finally(() => this.downloadProgress.set(undefined));
    })().catch(e => {
      this.#extractor = undefined;
      throw e;
    });
  }
}
