export interface ChunkInput {
  index: number;
  text: string;
  vector: Float32Array;
}

export interface SearchHit {
  id: number;
  docName: string;
  index: number;
  text: string;
  score: number;          // fused (RRF) score
  similarity?: number;    // cosine similarity, if it ranked in the vector list
  vectorRank?: number;    // 1-based
  keywordRank?: number;   // 1-based
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
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Reciprocal Rank Fusion: merges several ranked id lists into one.
 * score(id) = sum over lists of 1 / (k + rank). Robust without tuning score scales.
 */
export function reciprocalRankFusion(rankings: number[][], k = 60): { id: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/** Turns free text into a safe FTS5 query: each word quoted, OR'ed together. */
export function toFtsQuery(query: string): string {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms)].map(t => `"${t}"`).join(' OR ');
}

/** A safe, readable SQL identifier for a spreadsheet sheet, e.g. "Sales Q3.xlsx" + "Sheet1" -> sales_q3_sheet1. */
export function toTableName(fileName: string, sheetName?: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  const name = [base, sheetName].filter(Boolean).join('_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z_]/.test(name) ? name : `t_${name}`;
}
