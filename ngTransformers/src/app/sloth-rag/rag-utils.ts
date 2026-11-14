export interface ChunkInput {
  index: number;
  text: string;
  vector: Float32Array;
}

export interface DocumentSummary { docName: string; chunks: number; chars: number; }
export interface ChunkRow { id: number; index: number; text: string; vector: Float32Array; }

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

const STOP_WORDS = new Set((
  'a an and are as at be but by can do does for from had has have how i if in into is it its me my no not of on ' +
  'or our so that the their them then there these they this those to was we were what when where which who why ' +
  'will with you your'
).split(' '));

/** Unique lowercase words from a query, minus stop words (unless that would leave nothing). */
export function queryTerms(query: string): string[] {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const meaningful = terms.filter(t => !STOP_WORDS.has(t));
  return meaningful.length ? meaningful : terms;
}

/** Turns free text into a safe FTS5 query: each word quoted, OR'ed together. */
export function toFtsQuery(query: string): string {
  return queryTerms(query).map(t => `"${t}"`).join(' OR ');
}

export interface Span { start: number; end: number; }

/** Rough sentence spans (end-exclusive), splitting after . ! ? or newlines. */
export function splitSentences(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(/[^.!?\n]+(?:[.!?]+|\n|$)/g)) {
    const start = m.index! + (m[0].length - m[0].trimStart().length);
    const end = m.index! + m[0].trimEnd().length;
    if (end > start) spans.push({ start, end });
  }
  return spans;
}

export interface Segment { text: string; keyword: boolean; semantic: boolean; }

/**
 * Splits text into display segments flagged as keyword matches (whole-word, case-insensitive)
 * and/or inside the semantically best-matching sentence.
 */
export function highlightSegments(text: string, terms: string[], semantic?: Span): Segment[] {
  const keywordSpans: Span[] = [];
  if (terms.length) {
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) keywordSpans.push({ start: m.index!, end: m.index! + m[0].length });
  }

  const cuts = new Set([0, text.length]);
  for (const s of [...keywordSpans, ...(semantic ? [semantic] : [])]) { cuts.add(s.start); cuts.add(s.end); }
  const points = [...cuts].sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [start, end] = [points[i], points[i + 1]];
    const keyword = keywordSpans.some(s => s.start <= start && end <= s.end);
    const inSemantic = !!semantic && semantic.start <= start && end <= semantic.end;
    const last = segments.at(-1);
    if (last && last.keyword === keyword && last.semantic === inSemantic) last.text += text.slice(start, end);
    else segments.push({ text: text.slice(start, end), keyword, semantic: inSemantic });
  }
  return segments;
}

/** A CSS gradient "heat strip" of an embedding: red = positive, blue = negative. */
export function vectorGradient(v: Float32Array, scale = 0.15): string {
  const w = 100 / v.length;
  const stops = Array.from(v, (x, i) => {
    const t = Math.max(-1, Math.min(1, x / scale));
    const fade = Math.round(255 * (1 - Math.abs(t)));
    const color = t >= 0 ? `rgb(255,${fade},${fade})` : `rgb(${fade},${fade},255)`;
    return `${color} ${(i * w).toFixed(3)}% ${((i + 1) * w).toFixed(3)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
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

/**
 * Where the SQLite index lives:
 * - opening: worker starting
 * - persistent: OPFS, survives reloads
 * - memory: OPFS unsupported, lost on reload
 * - waiting: another tab owns the database; waiting for it
 * - moved: this tab handed the database to another tab
 */
export type StorageState = 'opening' | 'persistent' | 'memory' | 'waiting' | 'moved';

/** Below this cosine similarity, a hit with no keyword match is treated as noise. */
export const MIN_RESULT_SIMILARITY = 0.3;

/** A hit is worth showing if it matched a query word, or is semantically close enough. */
export function isStrongHit(hit: Pick<SearchHit, 'keywordRank' | 'similarity'>): boolean {
  return hit.keywordRank !== undefined || (hit.similarity ?? 0) >= MIN_RESULT_SIMILARITY;
}

/** Groups hits by document, keeping rank order (documents ordered by their best hit). */
export function groupHits<T extends { docName: string }>(hits: T[]): { docName: string; hits: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const h of hits) {
    const list = groups.get(h.docName);
    list ? list.push(h) : groups.set(h.docName, [h]);
  }
  return [...groups].map(([docName, hits]) => ({ docName, hits }));
}

/** Lowercase extension without the dot ('' if none). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
