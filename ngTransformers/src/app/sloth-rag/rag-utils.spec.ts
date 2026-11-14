import {
  chunkText, dot, highlightSegments, queryTerms, reciprocalRankFusion, splitSentences, toFtsQuery, toTableName,
  vectorGradient,
} from './rag-utils';

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

describe('queryTerms / toFtsQuery', () => {
  it('quotes and ORs unique words, dropping stop words and FTS5 syntax characters', () => {
    expect(toFtsQuery('What is "Q3" revenue? revenue* AND -NEAR(')).toBe('"q3" OR "revenue" OR "near"');
  });

  it('keeps stop words if the query is only stop words', () => {
    expect(queryTerms('who is it')).toEqual(['who', 'is', 'it']);
  });

  it('returns empty string when there are no words', () => {
    expect(toFtsQuery('?? !!')).toBe('');
  });
});

describe('splitSentences', () => {
  it('returns trimmed sentence spans', () => {
    const text = 'First one. Second!  Third?';
    expect(splitSentences(text).map(s => text.slice(s.start, s.end))).toEqual(['First one.', 'Second!', 'Third?']);
  });

  it('treats unpunctuated text as one sentence', () => {
    expect(splitSentences('a,b,c')).toEqual([{ start: 0, end: 5 }]);
  });
});

describe('highlightSegments', () => {
  const flags = (segs: ReturnType<typeof highlightSegments>) =>
    segs.map(s => `${s.keyword ? 'K' : ''}${s.semantic ? 'S' : ''}[${s.text}]`).join('');

  it('marks whole-word, case-insensitive keyword matches', () => {
    expect(flags(highlightSegments('Revenue rose; revenues fell', ['revenue'])))
      .toBe('K[Revenue][ rose; revenues fell]');
  });

  it('overlays a semantic sentence span with keyword matches', () => {
    const text = 'Sloths sleep. Q3 revenue grew.';
    expect(flags(highlightSegments(text, ['revenue'], { start: 14, end: 30 })))
      .toBe('[Sloths sleep. ]S[Q3 ]KS[revenue]S[ grew.]');
  });

  it('returns the whole text unflagged when nothing matches', () => {
    expect(highlightSegments('nothing here', ['zebra'])).toEqual([{ text: 'nothing here', keyword: false, semantic: false }]);
  });
});

describe('vectorGradient', () => {
  it('maps positive to red, negative to blue, zero to white', () => {
    const g = vectorGradient(Float32Array.from([0.15, -0.15, 0]));
    expect(g).toContain('rgb(255,0,0) 0.000% 33.333%');
    expect(g).toContain('rgb(0,0,255) 33.333% 66.667%');
    expect(g).toContain('rgb(255,255,255) 66.667% 100.000%');
  });
});

describe('toTableName', () => {
  it('builds snake_case identifiers from file and sheet names', () => {
    expect(toTableName('Sales Q3.xlsx', 'Sheet 1')).toBe('sales_q3_sheet_1');
    expect(toTableName('people.csv')).toBe('people');
    expect(toTableName('2024 report.xlsx', 'Data')).toBe('t_2024_report_data');
  });
});
