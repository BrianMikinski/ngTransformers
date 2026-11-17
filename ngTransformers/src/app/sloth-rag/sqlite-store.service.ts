import { Injectable, signal } from '@angular/core';
import { ChunkInput, ChunkRow, DocumentSummary, SearchHit, StorageState, StoredDocument } from './rag-utils';

const CHANNEL = 'sloth-rag-db';

/**
 * Thin promise-based RPC wrapper around the SQLite worker (see sqlite.worker.ts).
 * Also coordinates tabs: only one tab can own the OPFS database. "Use here" broadcasts a
 * release request; the owning tab terminates its worker, which frees the lock for us.
 */
@Injectable({ providedIn: 'root' })
export class SqliteStoreService {
  readonly state = signal<StorageState>('opening');

  #worker?: Worker;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #nextId = 0;
  #channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(CHANNEL);

  constructor() {
    this.#channel?.addEventListener('message', ({ data }) => {
      if (data === 'release' && this.#worker) this.#release();
    });
  }

  storage(): Promise<StorageState> { return this.#call('storage'); }
  count(): Promise<number> { return this.#call('count'); }
  documents(): Promise<DocumentSummary[]> { return this.#call('documents'); }
  document(name: string): Promise<StoredDocument | undefined> { return this.#call('document', name); }
  chunks(docName: string, limit = 500): Promise<ChunkRow[]> { return this.#call('chunks', docName, limit); }
  deleteDocument(docName: string): Promise<void> { return this.#call('deleteDocument', docName); }
  clear(): Promise<void> { return this.#call('clear'); }
  replaceDocument(doc: StoredDocument, chunks: ChunkInput[]): Promise<void> {
    return this.#call('replaceDocument', doc, chunks);
  }
  search(query: string, queryVector: Float32Array, k = 5): Promise<SearchHit[]> {
    return this.#call('search', query, queryVector, k);
  }

  /** Ask other tabs to let go of the database and (re)open it here. */
  takeOver(): Promise<StorageState> {
    this.#channel?.postMessage('release');
    return this.storage();
  }

  /** Another tab wants the database: stop our worker (frees the OPFS handles and the Web Lock). */
  #release() {
    this.#worker!.terminate();
    this.#worker = undefined;
    this.#failAll('The database moved to another tab');
    this.state.set('moved');
  }

  #call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.state() === 'moved' && method !== 'storage') {
      return Promise.reject(new Error('The database is open in another tab. Click "Use here" first.'));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#getWorker().postMessage({ id, method, args });
    });
  }

  #getWorker(): Worker {
    if (this.#worker) return this.#worker;
    this.state.set('opening');
    const worker = new Worker(new URL('./sqlite.worker', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.event === 'state') {
        this.state.set(data.state);
        return;
      }
      const { id, result, error } = data;
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
