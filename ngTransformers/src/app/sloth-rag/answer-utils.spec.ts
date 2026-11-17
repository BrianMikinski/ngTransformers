import {
  NOT_FOUND, answerCandidates, answerMessages, extractSql, fixGroupBy, isNotFound, isReadOnlySql, parseAnswer, buildSources, sqlExample, sqlMessages,
  sqlRepairMessages, stripThinking, tidy,
} from './answer-utils';
import { SearchHit } from './rag-utils';

const hit = (id: number, text: string): SearchHit =>
  ({ id, docName: `d${id}.txt`, index: 0, text, score: 1 / id } as SearchHit);

describe('answerCandidates', () => {
  const h = (id: number, similarity?: number, keywordRank?: number) => ({ ...hit(id, 'x'), similarity, keywordRank } as SearchHit);

  it('keeps hits close in meaning to the best one, plus top keyword matches', () => {
    const hits = [h(1, 0.47, 1), h(2, 0.36, 2), h(3, 0.25, 6), h(4, 0.18, 8), h(5, undefined, 3), h(6, undefined, 2)];
    expect(answerCandidates(hits).map(x => x.id)).toEqual([1, 2, 6]);
  });

  it('keeps keyword hits when nothing is semantically close (codes, names)', () => {
    expect(answerCandidates([h(1, 0.1, 1), h(2, 0.05)]).map(x => x.id)).toEqual([1]);
  });
});

describe('buildSources', () => {
  const ids = (s: { hit: SearchHit }[]) => s.map(x => x.hit.id);

  it('keeps rank order within the count and size budget', () => {
    const hits = [hit(1, 'a'.repeat(100)), hit(2, 'b'.repeat(100)), hit(3, 'c'.repeat(100))];
    expect(ids(buildSources(hits, 2))).toEqual([1, 2]);
    expect(ids(buildSources(hits, 5, 250))).toEqual([1, 2]);
    expect(ids(buildSources(hits))).toEqual([1, 2, 3]);
  });

  it('always includes the best hit, even when it is over budget', () => {
    expect(buildSources([hit(1, 'x'.repeat(500))], 5, 100).length).toBe(1);
  });

  it('merges overlapping passages of one document into one continuous source', () => {
    const doc = 'The quick brown fox jumps over the lazy dog.';
    const span = (id: number, start: number, end: number) =>
      ({ ...hit(id, doc.slice(start, end)), docName: 'a.txt', start, end }) as SearchHit;
    const sources = buildSources([span(1, 10, 30), span(2, 0, 15), span(3, 25, 44)]);
    expect(sources.length).toBe(1);
    expect(sources[0]).toMatchObject({ text: doc, start: 0, end: 44 });
    expect(sources[0].hit.id).toBe(1); // citation opens the best hit
  });
});

describe('answerMessages', () => {
  it('numbers the sources, tidies page markers, and asks the question last', () => {
    const [system, user] = answerMessages('how long?', [
      { docName: 'handbook.pdf', section: 'Page 2', text: ' --- Page 2 ---\n25 days. ' },
      { docName: 'notes.md', text: 'Weekly releases.' },
    ]);
    expect(system.role).toBe('system');
    expect(system.content).toContain(NOT_FOUND);
    expect(user.content).toBe(
      'Source [1] (from handbook.pdf, Page 2):\n(Page 2)\n25 days.\n\n' +
      'Source [2] (from notes.md):\nWeekly releases.\n\nQuestion: how long?',
    );
  });
});

describe('tidy', () => {
  it('drops a leading sentence fragment and rewrites page markers', () => {
    expect(tidy('twice a year.\n\n--- Page 2 ---\n3. Time off')).toBe('(Page 2)\n3. Time off');
    expect(tidy('Full sentence. Another.')).toBe('Full sentence. Another.');
    expect(tidy('lowercase start but no sentence end anywhere')).toBe('lowercase start but no sentence end anywhere');
  });
});

describe('parseAnswer', () => {
  it('turns [n] markers into citations', () => {
    expect(parseAnswer('You get 25 days [1]. Sick leave is separate [2].', 2)).toEqual([
      { text: 'You get 25 days ' }, { cite: 1 }, { text: '. Sick leave is separate ' }, { cite: 2 }, { text: '.' },
    ]);
  });

  it('understands lists, ranges and "Source n"', () => {
    const cites = (s: string) => parseAnswer(s, 5).filter(p => p.cite).map(p => p.cite);
    expect(cites('a [1, 3]')).toEqual([1, 3]);
    expect(cites('a [2-4]')).toEqual([2, 3, 4]);
    expect(cites('a [Source 2]')).toEqual([2]);
    expect(cites('a [sources 1 and 5]')).toEqual([1, 5]);
    expect(cites('a [1][1]')).toEqual([1]);
  });

  it('leaves out-of-range numbers and ordinary brackets as text', () => {
    expect(parseAnswer('see [7] and [note]', 3)).toEqual([{ text: 'see [7] and [note]' }]);
  });

  it('renders **bold** without the markers', () => {
    expect(parseAnswer('Status is **amber** [1].', 1)).toEqual([
      { text: 'Status is ' }, { text: 'amber', bold: true }, { text: ' ' }, { cite: 1 }, { text: '.' },
    ]);
    expect(parseAnswer('still **stream', 1)).toEqual([{ text: 'still **stream' }]);
  });

  it('drops an echoed source label', () => {
    expect(parseAnswer('[1] (from handbook.pdf, Pages 2): 25 days.', 1)).toEqual([{ cite: 1 }, { text: ' 25 days.' }]);
  });
});

describe('stripThinking', () => {
  it('removes finished and unfinished think blocks', () => {
    expect(stripThinking('<think>hmm</think>\n\nAnswer [1]')).toBe('Answer [1]');
    expect(stripThinking('<think>still going')).toBe('');
  });
});

describe('isNotFound', () => {
  it('spots the not-found reply but not a real answer that mentions finding', () => {
    expect(isNotFound(NOT_FOUND)).toBe(true);
    expect(isNotFound('You can find the PTO policy on page 2 [1].')).toBe(false);
  });
});

describe('sqlMessages', () => {
  it('describes each table as CREATE TABLE plus example rows', () => {
    const [, user] = sqlMessages('top rep?', [{
      table: 'q3_sales_sales',
      columns: [{ name: 'rep', type: 'VARCHAR' }, { name: 'revenue', type: 'BIGINT' }],
      sample: [['Ana', '38000']],
    }]);
    expect(user.content).toContain(
      'CREATE TABLE "q3_sales_sales" ("rep" VARCHAR, "revenue" BIGINT);\n-- Example rows:\n-- rep | revenue\n-- Ana | 38000\n\n',
    );
    expect(user.content.endsWith('\n\nQuestion: top rep?')).toBe(true);
  });

  it('adds a worked example on the real columns when there is a text and a number column', () => {
    const t = {
      table: 't',
      columns: [{ name: 'region', type: 'VARCHAR' }, { name: 'month', type: 'VARCHAR' }, { name: 'revenue', type: 'BIGINT' }],
      sample: [['North', "Jul'y", '38000']],
    };
    expect(sqlExample(t)).toContain(`WHERE "month" = 'Jul''y' ORDER BY "revenue" DESC LIMIT 1;`);
    expect(sqlExample(t)).toContain('SELECT "region", SUM("revenue") AS total_revenue\nFROM "t" GROUP BY "region"');
    expect(sqlExample({ ...t, columns: [{ name: 'a', type: 'VARCHAR' }] })).toBeUndefined();
  });

  it('repair prompt replays the failed query and the error', () => {
    const msgs = sqlRepairMessages([{ role: 'user', content: 'q' }], 'SELECT x', 'no column x');
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2].content).toContain('no column x');
    expect(msgs[2].content).not.toContain('SUM()');
    const grouped = sqlRepairMessages([], 'SELECT a, b FROM t GROUP BY a', 'Binder Error: column "b" must appear in the GROUP BY clause\nLINE 1: ...');
    expect(grouped[1].content).toContain('SUM(), AVG()');
    expect(grouped[1].content).not.toContain('LINE 1');
  });
});

describe('fixGroupBy', () => {
  const err = 'Binder Error: column "deals" must appear in the GROUP BY clause or must be part of an aggregate function.';
  const sql = 'SELECT "rep", "deals" FROM "t" GROUP BY "rep" ORDER BY "deals" DESC';

  it('wraps the column DuckDB complains about, aggregate chosen from the question', () => {
    expect(fixGroupBy(sql, err, 'total deals per rep'))
      .toBe('SELECT "rep", SUM("deals") AS "deals" FROM "t" GROUP BY "rep" ORDER BY "deals" DESC');
    expect(fixGroupBy(sql, err, 'average deals by rep')).toContain('AVG("deals") AS "deals"');
    expect(fixGroupBy(sql, err, 'which rep has the most deals')).toContain('MAX("deals")');
  });

  it('handles table-qualified and unquoted columns', () => {
    expect(fixGroupBy('select rep, t.deals from t group by rep', err, 'x')).toBe('select rep, SUM("deals") AS "deals" from t group by rep');
  });

  it('returns undefined for other errors or when the column is not a plain select item', () => {
    expect(fixGroupBy(sql, 'Catalog Error: table not found', 'x')).toBeUndefined();
    expect(fixGroupBy('SELECT "rep", "deals" * 2 FROM "t" GROUP BY "rep"', err, 'x')).toBeUndefined();
  });
});

describe('extractSql', () => {
  it('takes the query out of a code fence', () => {
    expect(extractSql('Here you go:\n```sql\nSELECT 1;\n```\nThis selects one.')).toBe('SELECT 1');
  });
  it('drops chatter before the query and anything after the first statement', () => {
    expect(extractSql('Sure! SELECT "a" FROM t WHERE b = \';\'; DROP TABLE t')).toBe('SELECT "a" FROM t WHERE b = \';\'');
  });
  it('handles an unterminated fence (generation cut short)', () => {
    expect(extractSql('```sql\nSELECT 2')).toBe('SELECT 2');
  });
});

describe('isReadOnlySql', () => {
  it('allows SELECT / WITH, rejects writes, ignores keywords inside strings', () => {
    expect(isReadOnlySql('SELECT * FROM t')).toBe(true);
    expect(isReadOnlySql('with x as (select 1) select * from x')).toBe(true);
    expect(isReadOnlySql("SELECT * FROM t WHERE note = 'drop it'")).toBe(true);
    expect(isReadOnlySql('DROP TABLE t')).toBe(false);
    expect(isReadOnlySql('SELECT 1; DELETE FROM t')).toBe(false);
  });
});
