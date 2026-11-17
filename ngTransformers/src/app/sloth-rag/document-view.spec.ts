import { compactSheet, documentLines, parseCsvRows, sectionLabel, sections, sheetTables } from './document-view';
import { highlightSegments } from './rag-utils';

const PDF = '--- Page 1 ---\nIntro text\n\n--- Page 2 ---\nMore text here\n\n--- Page 3 ---\nEnd';

describe('sections', () => {
  it('finds page markers with body offsets', () => {
    const s = sections(PDF);
    expect(s.map(x => x.label)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(PDF.slice(s[1].bodyStart, s[1].end).trim()).toBe('More text here');
  });

  it('keeps text before the first marker as an unlabeled section', () => {
    expect(sections('preamble\n--- Sheet: Sales ---\na,b').map(x => x.label)).toEqual(['', 'Sheet Sales']);
    expect(sections('no markers at all')).toEqual([{ label: '', start: 0, bodyStart: 0, end: 17 }]);
  });
});

describe('sectionLabel', () => {
  const s = sections(PDF);
  it('labels a passage by page, or a page range when it spans pages', () => {
    expect(sectionLabel(s, PDF.indexOf('More'), PDF.indexOf('here') + 4)).toBe('Page 2');
    expect(sectionLabel(s, PDF.indexOf('Intro'), PDF.indexOf('More') + 4)).toBe('Pages 1–2');
  });
  it('returns undefined for documents without sections', () => {
    expect(sectionLabel(sections('plain'), 0, 5)).toBeUndefined();
  });
});

describe('documentLines', () => {
  it('styles markdown lines but keeps the syntax as dimmed markers', () => {
    const lines = documentLines('# Title\n- item\n> quote\n```\ncode\n```\nplain', { markdown: true });
    expect(lines.map(l => l.kind)).toEqual(['h1', 'li', 'quote', 'code', 'code', 'code', 'p']);
    expect(lines[0].parts.map(p => [p.text, p.marker])).toEqual([['# ', true], ['Title', false]]);
  });

  it('keeps indented continuation lines inside their list item', () => {
    const lines = documentLines('- first line\n  continued\nafter', { markdown: true });
    expect(lines.map(l => l.kind)).toEqual(['li', 'li', 'p']);
  });

  it('turns section markers into section lines', () => {
    expect(documentLines(PDF).filter(l => l.kind === 'section').map(l => l.parts[0].text))
      .toEqual(['Page 1', 'Page 2', 'Page 3']);
  });

  it('highlights a hit at its offsets, carrying keyword marks across lines', () => {
    const text = 'before\nthe sloth sleeps\nafter';
    const start = text.indexOf('sloth'), end = text.indexOf('after') - 1;
    const segments = highlightSegments(text.slice(start, end), ['sleeps']);
    const lines = documentLines(text, { highlight: { start, end, segments } });

    expect(lines.map(l => l.hit)).toEqual([false, true, false]);
    expect(lines[1].parts.map(p => [p.text, p.hit, p.keyword])).toEqual([
      ['the ', false, false], ['sloth ', true, false], ['sleeps', true, true],
    ]);
  });
});

describe('parseCsvRows', () => {
  it('handles quotes, escaped quotes, quoted newlines and blank rows, with offsets', () => {
    const csv = 'a,"b,c"\n"say ""hi""","x\ny"\n,,\nlast,1';
    const rows = parseCsvRows(csv, 10);
    expect(rows.map(r => r.cells)).toEqual([['a', 'b,c'], ['say "hi"', 'x\ny'], ['last', '1']]);
    expect(rows[0]).toMatchObject({ start: 10, end: 17 });
  });
});

describe('sheetTables', () => {
  const text = '--- Sheet: Sales ---\nregion,revenue\nNorth,120\nWest,143\n\n--- Sheet: Empty ---\n';
  it('builds one table per sheet, flags rows inside the hit, marks query words', () => {
    const west = text.indexOf('West');
    const [sales, ...rest] = sheetTables(text, { terms: ['west'], hit: { start: west, end: west + 8 } });
    expect(rest).toEqual([]); // empty sheet dropped
    expect(sales.label).toBe('Sheet Sales');
    expect(sales.header.map(c => c.segments[0].text)).toEqual(['region', 'revenue']);
    expect(sales.rows.map(r => r.hit)).toEqual([false, true]);
    expect(sales.rows[1].cells[0].segments[0]).toMatchObject({ text: 'West', keyword: true });
  });

  it('can treat every row as data (snippets that start mid-sheet)', () => {
    expect(sheetTables('North,120\nWest,143', { header: false })[0].rows.length).toBe(2);
  });
});

describe('compactSheet', () => {
  it('prefers rows that match the query, else the first rows', () => {
    const csv = 'a,1\nb,2\nwest,3\nc,4';
    const [matched] = sheetTables(csv, { terms: ['west'], header: false }).map(t => compactSheet(t, 2));
    expect(matched.rows.map(r => r.cells[0].segments[0].text)).toEqual(['west']);
    expect(matched.hiddenRows).toBe(3);

    const [plain] = sheetTables(csv, { header: false }).map(t => compactSheet(t, 2));
    expect(plain.rows.length).toBe(2);
    expect(plain.hiddenRows).toBe(2);
  });
});
