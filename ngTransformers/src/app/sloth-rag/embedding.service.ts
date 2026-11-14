import { Injectable } from '@angular/core';
import { pipeline } from '@huggingface/transformers';

/** Sentence embeddings in the browser. The model (~23MB) downloads on first use, then is browser-cached. */
@Injectable({ providedIn: 'root' })
export class EmbeddingService {
  #extractor?: Promise<any>;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.#extractor ??= pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    const extractor = await this.#extractor;
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return (output.tolist() as number[][]).map(v => Float32Array.from(v));
  }
}
