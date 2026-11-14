import { Injectable } from '@angular/core';
import { ChunkInput, ChunkRow, DocumentSummary, SearchHit } from './rag-utils';

/** Thin promise-based RPC wrapper around the SQLite worker (see sqlite.worker.ts). */
@Injectable({ providedIn: 'root' })
export class SqliteStoreService {
  #worker?: Worker;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #nextId = 0;

  storage(): Promise<string> { return this.#call('storage'); }
  count(): Promise<number> { return this.#call('count'); }
  documents(): Promise<DocumentSummary[]> { return this.#call('documents'); }
  chunks(docName: string, limit = 200): Promise<ChunkRow[]> { return this.#call('chunks', docName, limit); }
  clear(): Promise<void> { return this.#call('clear'); }
  replaceDocument(docName: string, chunks: ChunkInput[]): Promise<void> {
    return this.#call('replaceDocument', docName, chunks);
  }
  search(query: string, queryVector: Float32Array, k = 5): Promise<SearchHit[]> {
    return this.#call('search', query, queryVector, k);
  }

  #call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#getWorker().postMessage({ id, method, args });
    });
  }

  #getWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL('./sqlite.worker', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: { id, result, error } }) => {
      const p = this.#pending.get(id);
      this.#pending.delete(id);
      error ? p?.reject(new Error(error)) : p?.resolve(result);
    };
    // Script failed to load or crashed: fail every in-flight call instead of hanging forever,
    // and drop the worker so the next call starts a fresh one.
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.#failAll(`SQLite worker failed: ${e.message || 'could not load worker script'}`);
      worker.terminate();
      this.#worker = undefined;
    };
    worker.onmessageerror = () => this.#failAll('SQLite worker sent an unreadable message');
    return this.#worker = worker;
  }

  #failAll(message: string) {
    for (const p of this.#pending.values()) p.reject(new Error(message));
    this.#pending.clear();
  }
}
