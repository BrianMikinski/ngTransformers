import { Injectable, signal } from '@angular/core';

/**
 * Sentence embeddings in a Web Worker (see embedding.worker.ts).
 * The model (~23MB) downloads on first use, then is browser-cached.
 */
@Injectable({ providedIn: 'root' })
export class EmbeddingService {
  /** Model download progress 0-100 while downloading, undefined otherwise. */
  readonly downloadProgress = signal<number | undefined>(undefined);

  #worker?: Worker;
  #pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
  #nextId = 0;

  embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return Promise.resolve([]);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#getWorker().postMessage({ id, texts });
    });
  }

  #getWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL('./embedding.worker', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.event === 'progress') {
        this.downloadProgress.set(data.progress);
        return;
      }
      const p = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      data.error ? p?.reject(new Error(data.error)) : p?.resolve(data.result);
    };
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      for (const p of this.#pending.values()) p.reject(new Error(`Embedding worker failed: ${e.message || 'could not load'}`));
      this.#pending.clear();
      this.downloadProgress.set(undefined);
      worker.terminate();
      this.#worker = undefined;
    };
    return this.#worker = worker;
  }
}
