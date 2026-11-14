import { Injectable } from '@angular/core';
import { StoredChunk } from './rag-utils';

const DB_NAME = 'sloth-rag';
const STORE = 'chunks';

/** Bare-bones IndexedDB store for chunks + embeddings. Search is brute force over everything. */
@Injectable({ providedIn: 'root' })
export class VectorStoreService {
  #db?: Promise<IDBDatabase>;

  /** Replaces any previously stored chunks for this document (re-uploads don't duplicate). */
  async replaceDocument(docName: string, chunks: StoredChunk[]): Promise<void> {
    const tx = (await this.#open()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.delete(IDBKeyRange.bound(`${docName}#`, `${docName}#￿`));
    chunks.forEach(c => store.put(c));
    await done(tx);
  }

  async all(): Promise<StoredChunk[]> {
    return request((await this.#open()).transaction(STORE).objectStore(STORE).getAll());
  }

  async count(): Promise<number> {
    return request((await this.#open()).transaction(STORE).objectStore(STORE).count());
  }

  async clear(): Promise<void> {
    const tx = (await this.#open()).transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
  }

  #open(): Promise<IDBDatabase> {
    return this.#db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
