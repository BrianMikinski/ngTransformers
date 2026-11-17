/**
 * Pure helpers for the answer model: prompts for written answers (RAG) and natural language → SQL,
 * plus parsing what the model writes back ([n] citations, SQL in code fences).
 */
import { SearchHit } from './rag-utils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const NOT_FOUND = "I couldn't find that in your documents.";

/** Removes a reasoning model's <think>…</think> block (also an unfinished one while streaming). */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trimStart();
}

// ---------- Written answers ----------

/**
 * Which results are worth showing the model. Stricter than the result list: a small model is easily
 * derailed by a passage that only shares a word with the question ("days"). Keeps hits whose meaning is
 * close to the best hit's, plus top keyword matches (exact names and codes that embeddings miss).
 */
export function answerCandidates<T extends SearchHit>(hits: T[], gap = 0.2, minSimilarity = 0.25): T[] {
  const best = Math.max(0, ...hits.map(h => h.similarity ?? 0));
  const floor = Math.max(minSimilarity, best - gap);
  return hits.filter(h => (h.similarity ?? 0) >= floor || (h.keywordRank !== undefined && h.keywordRank <= 2));
}

/** One numbered source for the model: a hit, or several overlapping hits of one document merged. */
export interface AnswerSource<T extends SearchHit = SearchHit> {
  /** The best-ranked hit in this source: what citation [n] opens. */
  hit: T;
  /** Every hit merged into this source (hit first). */
  hits: T[];
  docName: string;
  section?: string;
  text: string;
  start?: number;
  end?: number;
}

/**
 * The passages handed to the model, best first, within a size budget (small model, slow prompt reading).
 * Hits that overlap or touch in the same document (chunks overlap by design) are merged into one
 * continuous passage, so the model doesn't see the same sentences three times, cut mid-sentence.
 */
export function buildSources<T extends SearchHit>(hits: T[], max = 4, maxChars = 2000): AnswerSource<T>[] {
  const sources: AnswerSource<T>[] = [];
  const size = () => sources.reduce((n, s) => n + s.text.length, 0);
  const exact = (h: SearchHit) => h.start !== undefined && h.end !== undefined && h.end - h.start === h.text.length;

  for (const h of hits) {
    const into = exact(h)
      ? sources.find(s => s.docName === h.docName && s.start !== undefined && h.start! <= s.end! && h.end! >= s.start)
      : undefined;
    if (into) {
      const before = into.start! - h.start!, after = h.end! - into.end!;
      const merged = (before > 0 ? h.text.slice(0, before) : '') + into.text + (after > 0 ? h.text.slice(h.text.length - after) : '');
      if (size() - into.text.length + merged.length > maxChars) continue;
      into.text = merged;
      into.hits.push(h);
      into.start = Math.min(into.start!, h.start!);
      into.end = Math.max(into.end!, h.end!);
      continue;
    }
    if (sources.length >= max) continue;
    if (sources.length && size() + h.text.length > maxChars) continue;
    sources.push({
      hit: h, hits: [h], docName: h.docName, section: h.section, text: h.text,
      ...(exact(h) ? { start: h.start, end: h.end } : {}),
    });
  }
  return sources;
}

export interface SourceText {
  docName: string;
  section?: string;
  text: string;
}

export function answerMessages(question: string, sources: SourceText[]): ChatMessage[] {
  const system = [
    "You answer questions using only the numbered sources, which are passages from the user's own documents.",
    'Rules:',
    '- Start directly with the answer, in one to four short sentences.',
    '- After each fact, write the number of the source it came from in square brackets, like [1] or [2].',
    `- If the sources do not answer the question, reply only: ${NOT_FOUND}`,
    // Without this, a 0.6B model answers "not found" to "vacation days" when the source says "paid time off".
    '- The sources may use different words than the question. Answer when they mean the same thing.',
    '- Do not use outside knowledge.',
  ].join('\n');
  const blocks = sources.map((s, i) =>
    `Source [${i + 1}] (from ${s.docName}${s.section ? `, ${s.section}` : ''}):\n${tidy(s.text)}`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${blocks.join('\n\n')}\n\nQuestion: ${question}` },
  ];
}

/**
 * Passages are cut at word boundaries, so one often starts mid-sentence ("twice a year and attendance is
 * expected."); a small model tends to parrot that fragment back as the answer. Drop it, and turn section
 * marker lines ("--- Page 2 ---") into "(Page 2)": the same information, less noise.
 */
export function tidy(text: string): string {
  let t = text.trim();
  if (/^[a-z]/.test(t)) {
    const cut = t.search(/[.!?](\s|$)|\n/);
    if (cut >= 0 && cut < t.length / 2) t = t.slice(cut + 1).trim();
  }
  return t.replace(/^--- (Page \d+|Sheet: .*) ---[ \t]*$/gm, '($1)');
}

/** Answer text cut into plain text and citations. */
export interface AnswerPart {
  text?: string;
  cite?: number;
  /** Markdown **bold** in the answer (the markers are removed). */
  bold?: boolean;
}

/** "[1]", "[1, 2]", "[1-3]", "[Source 2]", "[sources 1 and 3]". */
const CITE_RE = /\[\s*(?:(?:sources?|passages?)\s*)?(\d+(?:\s*(?:,|;|-|–|and)\s*(?:(?:sources?|passages?)\s*)?\d+)*)\s*\]/gi;

/** Splits an answer into text and citation parts. Numbers outside 1..count stay as plain text. */
export function parseAnswer(text: string, count: number): AnswerPart[] {
  // Small models sometimes echo the source label: "[1] (from handbook.pdf, Page 2): …".
  text = stripThinking(text).replace(/\(from [^)\n]*\)\s*:?\s*/g, '');
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE_RE)) {
    const nums = citeNumbers(m[1]).filter(n => n >= 1 && n <= count);
    if (!nums.length) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    for (const n of nums) {
      if (parts.at(-1)?.cite !== n) parts.push({ cite: n }); // "[1][1]" → one chip
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.flatMap(p => (p.text === undefined ? [p] : boldParts(p.text)));
}

/** "a **b** c" → a, b (bold), c. An unclosed ** (still streaming) stays as text. */
function boldParts(text: string): AnswerPart[] {
  return text.split(/\*\*([^*\n]+?)\*\*/).flatMap((t, i) => (t ? [i % 2 ? { text: t, bold: true } : { text: t }] : []));
}

function citeNumbers(s: string): number[] {
  const tokens = s.match(/\d+|[-–]/g) ?? [];
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === '-' || t === '–') && out.length && /\d/.test(tokens[i + 1] ?? '')) {
      const from = out[out.length - 1], to = Number(tokens[++i]);
      for (let n = from + 1; n <= to && n - from <= 20; n++) out.push(n);
    } else if (/\d/.test(t)) {
      out.push(Number(t));
    }
  }
  return out;
}

export function isNotFound(text: string): boolean {
  return /\b(couldn'?t|could not|can'?t|cannot) find\b/i.test(text) && text.length < 160;
}

// ---------- Natural language → SQL ----------

export interface TableSchema {
  table: string;
  columns: { name: string; type: string }[];
  /** A few rows so the model sees real values (spelling, casing, formats). */
  sample: string[][];
}

/** The model's reply starts here, so it can only continue a SELECT query. */
export const SQL_PREFIX = '```sql\nSELECT';

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|DOUBLE|FLOAT|REAL|DECIMAL|UBIGINT|UINTEGER)/i;

/**
 * Worked examples on the user's own columns, so a small model sees the two shapes most questions need:
 * filter + sort (with a real value from the sheet), and group + aggregate.
 */
export function sqlExample(t: TableSchema): string | undefined {
  const texts = t.columns.filter(c => /^VARCHAR/i.test(c.type));
  const num = t.columns.find(c => NUMERIC.test(c.type));
  if (!texts.length || !num) return undefined;
  const [group] = texts;
  const filter = texts[1] ?? texts[0];
  const value = t.sample[0]?.[t.columns.indexOf(filter)];
  const examples: string[] = [];
  if (value) {
    examples.push([
      `Example question: which ${group.name} had the highest ${num.name} where ${filter.name} is ${value}?`,
      `Example answer:\nSELECT "${group.name}", "${num.name}" FROM "${t.table}"`,
      `WHERE "${filter.name}" = '${value.replace(/'/g, "''")}' ORDER BY "${num.name}" DESC LIMIT 1;`,
    ].join('\n'));
  }
  examples.push([
    `Example question: total ${num.name} for each ${group.name}, largest first`,
    `Example answer:\nSELECT "${group.name}", SUM("${num.name}") AS total_${num.name}`,
    `FROM "${t.table}" GROUP BY "${group.name}" ORDER BY total_${num.name} DESC;`,
  ].join('\n'));
  return examples.join('\n\n');
}

export function sqlMessages(question: string, tables: TableSchema[]): ChatMessage[] {
  const system = [
    'You translate questions about spreadsheet data into DuckDB SQL.',
    'Reply with one SELECT query and nothing else.',
    'Use only the tables and columns listed. Put double quotes around table and column names,',
    'and single quotes around text values.',
    'Every selected column must be in GROUP BY or inside an aggregate like SUM, AVG, COUNT or MAX.',
  ].join('\n');
  const schema = tables.map(t => [
    `CREATE TABLE "${t.table}" (${t.columns.map(c => `"${c.name}" ${c.type}`).join(', ')});`,
    '-- Example rows:',
    `-- ${t.columns.map(c => c.name).join(' | ')}`,
    ...t.sample.map(r => `-- ${r.join(' | ')}`),
  ].join('\n'));
  const example = tables.map(sqlExample).find(Boolean);
  return [
    { role: 'system', content: system },
    { role: 'user', content: [...schema, ...(example ? [example] : []), `Question: ${question}`].join('\n\n') },
  ];
}

/** Ask the model to fix a query DuckDB rejected. */
export function sqlRepairMessages(messages: ChatMessage[], sql: string, error: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: sql },
    {
      role: 'user',
      content: [
        `DuckDB rejected that query with this error:\n${error.split('\n')[0]}`,
        // The mistake small models make most; spelling out the fix works better than the raw error.
        ...(/GROUP BY clause/i.test(error) ? ['Wrap each selected column that is not in GROUP BY in SUM(), AVG(), COUNT() or MAX().'] : []),
        'Reply with a corrected SELECT query only.',
      ].join('\n'),
    },
  ];
}

/**
 * Fixes the most common small-model mistake without another (slow) model call: a plain column in the
 * SELECT list of a GROUP BY query. DuckDB names the column; it gets wrapped in an aggregate picked from
 * the question's wording (SUM unless it says average / highest / lowest / how many).
 * Returns undefined when the error isn't that, or the column can't be found.
 */
export function fixGroupBy(sql: string, error: string, question: string): string | undefined {
  const column = /column "([^"]+)" must appear in the GROUP BY clause/i.exec(error)?.[1];
  const select = /^(\s*select\s+(?:distinct\s+)?)([\s\S]*?)(\s+from\s[\s\S]*)$/i.exec(sql);
  if (!column || !select) return undefined;

  const q = question.toLowerCase();
  const agg = /\b(average|avg|mean)\b/.test(q) ? 'AVG'
    : /\b(how many|count|number of)\b/.test(q) ? 'COUNT'
    : /\b(max|maximum|highest|largest|biggest|most|top|best)\b/.test(q) ? 'MAX'
    : /\b(min|minimum|lowest|smallest|least|worst)\b/.test(q) ? 'MIN'
    : 'SUM';

  const name = column.replace(/"/g, '');
  const plain = new RegExp(`^(?:"?[\\w ]+"?\\.)?"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?$`, 'i');
  let fixed = false;
  const items = splitTopLevel(select[2]).map(item => {
    if (!plain.test(item.trim())) return item;
    fixed = true;
    return `${item.match(/^\s*/)![0]}${agg}("${name}") AS "${name}"`;
  });
  return fixed ? select[1] + items.join(',') + select[3] : undefined;
}

/** Splits on commas that aren't inside parentheses or quotes. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | undefined, start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) { if (ch === quote) quote = undefined; }
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out;
}

/** The first SQL statement in a model reply (code fences and chatter removed). */
export function extractSql(reply: string): string {
  let s = stripThinking(reply).trim();
  const fence = /```[a-z]*\s*([\s\S]*?)(?:```|$)/i.exec(s);
  if (fence) {
    s = fence[1];
  } else {
    const at = s.search(/\b(with|select)\b/i);
    if (at > 0) s = s.slice(at);
  }
  return firstStatement(s).trim();
}

/** Text up to the first ';' that isn't inside quotes. */
function firstStatement(sql: string): string {
  let quote: string | undefined;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ';') {
      return sql.slice(0, i);
    }
  }
  return sql;
}

/** Only queries that read run automatically; anything else is shown for the user to run themselves. */
export function isReadOnlySql(sql: string): boolean {
  return /^\s*(select|with)\b/i.test(sql) && !/\b(insert|update|delete|drop|create|alter|attach|copy|install|load|pragma|set)\b/i.test(stripStrings(sql));
}

function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
}
