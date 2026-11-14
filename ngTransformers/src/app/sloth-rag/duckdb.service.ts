import { Injectable } from '@angular/core';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

export interface TableInfo { table: string; columns: string; }
export interface SqlResult { columns: string[]; rows: string[][]; total: number; }

const MAX_ROWS = 500;

/**
 * DuckDB-WASM, fully in the browser. The worker + wasm are self-hosted (copied to /duckdb by
 * angular.json), and the JS is dynamically imported, so nothing loads until the first spreadsheet.
 * Tables live in memory only: re-upload spreadsheets after a page reload.
 */
@Injectable({ providedIn: 'root' })
export class DuckDbService {
  #conn?: Promise<{ db: AsyncDuckDB; conn: AsyncDuckDBConnection }>;

  /** Loads CSV text into (or replaces) a table. */
  async loadCsv(table: string, csv: string): Promise<void> {
    const { db, conn } = await this.#open();
    const file = `${table}.csv`;
    await db.registerFileText(file, csv);
    await conn.query(`CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM read_csv_auto('${file}')`);
  }

  async dropTables(tables: string[]): Promise<void> {
    if (!tables.length || !this.#conn) return;
    const { conn } = await this.#open();
    for (const t of tables) await conn.query(`DROP TABLE IF EXISTS "${t}"`);
  }

  async tables(): Promise<TableInfo[]> {
    const r = await this.query(`
      SELECT table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position)
      FROM information_schema.columns GROUP BY table_name ORDER BY table_name`);
    return r.rows.map(([table, columns]) => ({ table, columns }));
  }

  async query(sql: string): Promise<SqlResult> {
    const { conn } = await this.#open();
    const result = await conn.query(sql);
    const columns = result.schema.fields.map(f => f.name);
    const rows = result.toArray().slice(0, MAX_ROWS).map(row => {
      const obj = row.toJSON();
      return columns.map(c => (obj[c] == null ? '' : String(obj[c])));
    });
    return { columns, rows, total: result.numRows };
  }

  #open() {
    return this.#conn ??= (async () => {
      const duckdb = await import('@duckdb/duckdb-wasm');
      const worker = new Worker(new URL('duckdb/duckdb-browser-eh.worker.js', document.baseURI));
      // If the worker script can't load, DuckDB would wait forever; surface it as an error instead.
      const workerFailed = new Promise<never>((_, reject) => worker.addEventListener('error', e => {
        e.preventDefault();
        reject(new Error(`DuckDB worker failed: ${e.message || 'could not load duckdb/duckdb-browser-eh.worker.js'}`));
      }));
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await Promise.race([db.instantiate(new URL('duckdb/duckdb-eh.wasm', document.baseURI).href), workerFailed]);
      return { db, conn: await db.connect() };
    })().catch(e => {
      this.#conn = undefined; // allow a retry on the next call
      throw e;
    });
  }
}
