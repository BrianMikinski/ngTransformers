import { chunkText, StoredChunk, topK } from './rag-utils';

describe('chunkText', () => {
  it('returns nothing for empty or whitespace text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t ')).toEqual([]);
  });

  it('keeps short text as a single chunk with whitespace collapsed', () => {
    expect(chunkText('hello\n\n  sloth')).toEqual(['hello sloth']);
  });

  it('splits long text into overlapping chunks on word boundaries', () => {
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(' '), 100, 20);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      c.split(' ').forEach(w => expect(words).toContain(w)); // no split words
    }
    // Consecutive chunks overlap, and the last word is not lost.
    expect(chunks[1].split(' ')).toContain(chunks[0].split(' ').at(-1));
    expect(chunks.at(-1)!.endsWith('w299')).toBe(true);
  });
});

describe('topK', () => {
  const chunk = (id: string, v: number[]): StoredChunk =>
    ({ id, docName: 'd', index: 0, text: id, vector: Float32Array.from(v) });

  it('ranks chunks by similarity and limits to k', () => {
    const chunks = [chunk('a', [1, 0]), chunk('b', [0, 1]), chunk('c', [0.6, 0.8])];
    const results = topK(Float32Array.from([0, 1]), chunks, 2);
    expect(results.map(r => r.id)).toEqual(['b', 'c']);
    expect(results[0].score).toBeCloseTo(1);
  });
});
