/**
 * Pure helpers that turn a stored document's text into something renderable, with a search hit
 * highlighted in place. Offsets always refer to the original text, so a hit's [start, end) and its
 * keyword/sentence segments line up with what's displayed.
 */
import { Segment, highlightSegments } from './rag-utils';

/** Section markers written by DocumentParserService ("--- Page 3 ---", "--- Sheet: Sales ---"). */
const SECTION_RE = /^--- (?:Page (\d+)|Sheet: (.*)) ---[ \t]*$/gm;

export interface Section {
  /** "Page 3" / "Sheet Sales"; '' for text before the first marker. */
  label: string;
  page?: number;
  /** Where the marker line starts (== bodyStart when there's no marker). */
  start: number;
  /** Where the content after the marker line starts. */
  bodyStart: number;
  end: number;
}

export function sections(text: string): Section[] {
  const markers = Array.from(text.matchAll(SECTION_RE), m => ({
    label: m[1] ? `Page ${m[1]}` : `Sheet ${m[2]}`,
    page: m[1] ? Number(m[1]) : undefined,
    start: m.index!,
    bodyStart: Math.min(text.length, m.index! + m[0].length + 1),
  }));
  const result: Section[] = [];
  const firstStart = markers[0]?.start ?? text.length;
  if (text.slice(0, firstStart).trim()) result.push({ label: '', start: 0, bodyStart: 0, end: firstStart });
  markers.forEach((m, i) => result.push({ ...m, end: markers[i + 1]?.start ?? text.length }));
  return result;
}

/** Label for a passage: "Page 3", "Pages 3–4", "Sheet Sales", or undefined if the doc has no sections. */
export function sectionLabel(all: Section[], start: number, end: number): string | undefined {
  const at = (offset: number) => {
    let found: Section | undefined;
    for (const s of all) if (s.start <= offset) found = s;
    return found;
  };
  const a = at(start), b = at(Math.max(start, end - 1));
  if (!a?.label) return undefined;
  if (a.page && b?.page && b.page !== a.page) return `Pages ${a.page}–${b.page}`;
  return a.label;
}

// ---------- Text documents ----------

export interface ViewPart {
  text: string;
  hit: boolean;
  keyword: boolean;
  semantic: boolean;
  /** Markdown syntax (#, -, >) shown dimmed rather than removed, so offsets stay exact. */
  marker: boolean;
}

export type LineKind = 'section' | 'h1' | 'h2' | 'h3' | 'li' | 'quote' | 'code' | 'hr' | 'p' | 'blank';

export interface ViewLine {
  kind: LineKind;
  parts: ViewPart[];
  hit: boolean;
}

/** A hit to highlight: its offset in the document plus the segments computed on its text. */
export interface Highlight {
  start: number;
  end: number;
  segments: Segment[];
}

interface Interval { start: number; end: number; keyword: boolean; semantic: boolean; }

/** Hit segments → absolute intervals in the document. */
function hitIntervals(h: Highlight): Interval[] {
  const out: Interval[] = [];
  let at = h.start;
  for (const s of h.segments) {
    out.push({ start: at, end: at + s.text.length, keyword: s.keyword, semantic: s.semantic });
    at += s.text.length;
  }
  // Segments should cover the hit exactly; if not (legacy rows), fall back to one plain interval.
  return at === h.end ? out : [{ start: h.start, end: h.end, keyword: false, semantic: false }];
}

/**
 * Splits a document into display lines. Markdown gets light styling (headings, lists, quotes, code)
 * with the syntax kept visible but dimmed; everything else is plain paragraphs. Section markers become
 * section headings.
 */
export function documentLines(text: string, opts: { markdown?: boolean; highlight?: Highlight } = {}): ViewLine[] {
  const intervals = opts.highlight ? hitIntervals(opts.highlight) : [];
  const lines: ViewLine[] = [];
  let inCode = false;
  let lineStart = 0;

  for (const raw of text.split('\n')) {
    const start = lineStart, end = start + raw.length;
    lineStart = end + 1;

    const section = /^--- (?:Page (\d+)|Sheet: (.*)) ---[ \t]*$/.exec(raw);
    if (section) {
      const label = section[1] ? `Page ${section[1]}` : `Sheet ${section[2]}`;
      lines.push({ kind: 'section', parts: [plain(label)], hit: false });
      continue;
    }

    let kind: LineKind = raw.trim() ? 'p' : 'blank';
    let markerLength = 0;
    if (opts.markdown) {
      const fence = /^\s*(```|~~~)/.test(raw);
      if (fence || inCode) {
        kind = 'code';
        if (fence) inCode = !inCode;
      } else {
        let m: RegExpExecArray | null;
        if ((m = /^(#{1,6})\s+/.exec(raw))) {
          kind = m[1].length === 1 ? 'h1' : m[1].length === 2 ? 'h2' : 'h3';
          markerLength = m[0].length;
        } else if ((m = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(raw))) {
          kind = 'li';
          markerLength = m[0].length;
        } else if ((m = /^\s*>\s?/.exec(raw))) {
          kind = 'quote';
          markerLength = m[0].length;
        } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
          kind = 'hr';
        } else if ((m = /^\s{2,}(?=\S)/.exec(raw)) && lines.at(-1)?.kind === 'li') {
          kind = 'li'; // indented continuation of a list item: the indent is the "marker"
          markerLength = m[0].length;
        }
      }
    }

    const parts = cutLine(text, start, end, start + markerLength, intervals);
    lines.push({ kind, parts, hit: parts.some(p => p.hit) });
  }
  return lines;
}

function plain(text: string): ViewPart {
  return { text, hit: false, keyword: false, semantic: false, marker: false };
}

/** Cuts [start, end) at the marker boundary and at every highlight interval edge. */
function cutLine(text: string, start: number, end: number, markerEnd: number, intervals: Interval[]): ViewPart[] {
  const cuts = new Set([start, end, markerEnd]);
  for (const iv of intervals) {
    if (iv.end > start && iv.start < end) { cuts.add(Math.max(start, iv.start)); cuts.add(Math.min(end, iv.end)); }
  }
  const points = [...cuts].filter(p => p >= start && p <= end).sort((a, b) => a - b);
  const parts: ViewPart[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (a === b) continue;
    const iv = intervals.find(x => x.start <= a && b <= x.end);
    parts.push({ text: text.slice(a, b), hit: !!iv, keyword: !!iv?.keyword, semantic: !!iv?.semantic, marker: b <= markerEnd });
  }
  return parts;
}

// ---------- Spreadsheets ----------

export interface CsvRow {
  cells: string[];
  start: number;
  end: number;
}

/** Minimal CSV parser (quotes, escaped quotes, quoted newlines) that keeps row offsets. Blank rows are dropped. */
export function parseCsvRows(text: string, base = 0): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let rowStart = 0;

  for (let i = 0; i <= text.length; i++) {
    const atEnd = i === text.length;
    const ch = text[i];
    if (inQuotes && !atEnd) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || atEnd) {
      cells.push(cell.replace(/\r$/, ''));
      if (cells.some(c => c.trim())) rows.push({ cells, start: base + rowStart, end: base + i });
      cells = [];
      cell = '';
      inQuotes = false;
      rowStart = i + 1;
    } else {
      cell += ch;
    }
  }
  return rows;
}

export interface ViewCell { segments: Segment[]; }
export interface ViewRow {
  cells: ViewCell[];
  /** Inside the selected passage. */
  hit: boolean;
  /** Some cell contains a query word. */
  match: boolean;
}
export interface ViewSheet {
  label: string;
  header: ViewCell[];
  rows: ViewRow[];
  /** Rows left out by compactSheet(). */
  hiddenRows?: number;
}

/**
 * Spreadsheet text (CSV per "--- Sheet: x ---" section) → tables. Rows overlapping [hit.start, hit.end)
 * are flagged; query words are marked per cell. The first row of each sheet is treated as the header.
 */
export function sheetTables(
  text: string,
  opts: { terms?: string[]; hit?: { start: number; end: number }; header?: boolean } = {},
): ViewSheet[] {
  const terms = opts.terms ?? [];
  const cell = (c: string): ViewCell => ({ segments: highlightSegments(c, terms) });
  return sections(text).map(sec => {
    const all = parseCsvRows(text.slice(sec.bodyStart, sec.end), sec.bodyStart);
    // A passage can start mid-sheet, so callers showing snippets turn the header row off.
    const header = opts.header === false ? undefined : all[0];
    const rows = header ? all.slice(1) : all;
    return {
      label: sec.label,
      header: header?.cells.map(cell) ?? [],
      rows: rows.map(r => {
        const cells = r.cells.map(cell);
        return {
          cells,
          hit: !!opts.hit && r.end > opts.hit.start && r.start < opts.hit.end,
          match: cells.some(c => c.segments.some(seg => seg.keyword)),
        };
      }),
    };
  }).filter(s => s.header.length || s.rows.length);
}

/** For result snippets: keep rows that match the query (or the first rows if none do), up to `max`. */
export function compactSheet(sheet: ViewSheet, max = 6): ViewSheet {
  const matching = sheet.rows.filter(r => r.match);
  const rows = (matching.length ? matching : sheet.rows).slice(0, max);
  return { ...sheet, rows, hiddenRows: sheet.rows.length - rows.length };
}
