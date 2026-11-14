export interface StoredChunk {
  id: string;        // `${docName}#${index}`
  docName: string;
  index: number;
  text: string;
  vector: Float32Array;
}

export interface SearchResult extends StoredChunk {
  score: number;
}

/** Naive character-window chunker that tries to break on spaces. */
export function chunkText(text: string, size = 500, overlap = 100): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(' ', end);
      if (lastSpace > start + size / 2) end = lastSpace;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;

    // Step back by `overlap`, snapped forward to the next word boundary.
    const next = clean.indexOf(' ', end - overlap);
    start = next > start && next < end ? next + 1 : end;
  }
  return chunks.filter(c => c.length > 0);
}

/** Vectors are normalized at embed time, so the dot product is cosine similarity. */
export function topK(query: Float32Array, chunks: StoredChunk[], k = 5): SearchResult[] {
  return chunks
    .map(c => ({ ...c, score: dot(query, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
