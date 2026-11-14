import { chunkText, dot, reciprocalRankFusion, toFtsQuery, toTableName } from './rag-utils';

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

describe('dot', () => {
  it('computes the dot product', () => {
    expect(dot(Float32Array.from([1, 2, 3]), Float32Array.from([4, 5, 6]))).toBe(32);
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards ids that rank well in multiple lists', () => {
    const fused = reciprocalRankFusion([[1, 2, 3], [3, 4, 1]]);
    expect(fused.map(f => f.id)).toEqual([1, 3, 2, 4]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 63);
  });

  it('handles empty rankings', () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe('toFtsQuery', () => {
  it('quotes and ORs unique words, dropping FTS5 syntax characters', () => {
    expect(toFtsQuery('What is "Q3" revenue? revenue* AND -NEAR(')).toBe(
      '"what" OR "is" OR "q3" OR "revenue" OR "and" OR "near"');
  });

  it('returns empty string when there are no words', () => {
    expect(toFtsQuery('?? !!')).toBe('');
  });
});

describe('toTableName', () => {
  it('builds snake_case identifiers from file and sheet names', () => {
    expect(toTableName('Sales Q3.xlsx', 'Sheet 1')).toBe('sales_q3_sheet_1');
    expect(toTableName('people.csv')).toBe('people');
    expect(toTableName('2024 report.xlsx', 'Data')).toBe('t_2024_report_data');
  });
});
