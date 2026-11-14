import { Injectable } from '@angular/core';
import { ChunkInput, SearchHit } from './rag-utils';

/** Thin promise-based RPC wrapper around the SQLite worker (see sqlite.worker.ts). */
@Injectable({ providedIn: 'root' })
export class SqliteStoreService {
  #worker?: Worker;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #nextId = 0;

  storage(): Promise<string> { return this.#call('storage'); }
  count(): Promise<number> { return this.#call('count'); }
  clear(): Promise<void> { return this.#call('clear'); }
  replaceDocument(docName: string, chunks: ChunkInput[]): Promise<void> {
    return this.#call('replaceDocument', docName, chunks);
  }
  search(query: string, queryVector: Float32Array, k = 5): Promise<SearchHit[]> {
    return this.#call('search', query, queryVector, k);
  }

  #call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.#worker) {
      this.#worker = new Worker(new URL('./sqlite.worker', import.meta.url), { type: 'module' });
      this.#worker.onmessage = ({ data: { id, result, error } }) => {
        const p = this.#pending.get(id);
        this.#pending.delete(id);
        error ? p?.reject(new Error(error)) : p?.resolve(result);
      };
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker!.postMessage({ id, method, args });
    });
  }
}
