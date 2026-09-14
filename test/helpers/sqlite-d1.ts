/**
 * sqlite-d1.ts — Shared real-SQLite D1 test harness.
 *
 * Purpose: run production SQL against a genuine SQLite engine instead of the
 *   hand-written D1Mock, so query shape, CHECK constraints, UNIQUE races and
 *   transactional rollback behave the way D1 behaves.
 * Input: db/schema.sql (or an explicit schema string) and injected failure hooks.
 * Output: a `D1Database`-shaped object plus row helpers.
 * Logic: `node:sqlite` DatabaseSync in memory, manual BEGIN/COMMIT/ROLLBACK for
 *   batch(), and an optional top-level compound-SELECT term limit that reproduces
 *   the Workerd five-term configuration (SQLITE_LIMIT_COMPOUND_SELECT = 5).
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const WORKERD_COMPOUND_SELECT_TERMS = 5;

let cachedSchema: string | null = null;

export function loadSchema(): string {
  if (cachedSchema === null) {
    cachedSchema = readFileSync(resolve(process.cwd(), "db/schema.sql"), "utf8");
  }
  return cachedSchema;
}

/**
 * Count the top-level terms of a compound SELECT. Subqueries inside
 * parentheses are not compound terms, so nested SELECTs are stripped first.
 * Returns 1 for a non-compound statement.
 */
export function countCompoundSelectTerms(sql: string): number {
  let stripped = sql;
  // Remove innermost parenthesised groups repeatedly so nested subqueries do
  // not inflate the count. Comments and string literals are not used in the
  // statements under test.
  for (let pass = 0; pass < 32; pass++) {
    const next = stripped.replace(/\([^()]*\)/g, " () ");
    if (next === stripped) break;
    stripped = next;
  }
  const operators = stripped.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi);
  return 1 + (operators?.length ?? 0);
}

export class SqliteStatement {
  constructor(
    readonly owner: SqliteD1,
    readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.owner, this.sql, values);
  }

  private assertCompoundLimit(): void {
    const limit = this.owner.maxCompoundSelectTerms;
    if (limit === null) return;
    const terms = countCompoundSelectTerms(this.sql);
    if (terms > limit) {
      // Mirrors SQLite's "too many terms in compound SELECT" at the Workerd limit.
      throw new Error(
        `too many terms in compound SELECT (${terms} > ${limit}): ${this.sql.replace(/\s+/g, " ").trim().slice(0, 120)}`,
      );
    }
  }

  async run(): Promise<any> {
    this.assertCompoundLimit();
    this.owner.executed.push(this.sql.replace(/\s+/g, " ").trim());
    const statement = this.owner.sqlite.prepare(this.sql);
    if (statement.columns().length > 0) {
      // D1 batch returns SELECT/RETURNING rows. Execute once and retain them;
      // StatementSync.run() discards the rows even when the mutation succeeds.
      const before = this.owner.one<{ n: number }>("SELECT total_changes() AS n").n;
      const results = statement.all(...this.values as SQLInputValue[]);
      const changes = this.owner.one<{ n: number }>("SELECT total_changes() AS n").n - before;
      return { success: true, results, meta: { changes } };
    }
    const result = statement.run(...this.values as SQLInputValue[]);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async all<T = Record<string, unknown>>(): Promise<any> {
    this.assertCompoundLimit();
    this.owner.executed.push(this.sql.replace(/\s+/g, " ").trim());
    const results = this.owner.sqlite
      .prepare(this.sql)
      .all(...this.values as SQLInputValue[]) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    this.assertCompoundLimit();
    this.owner.executed.push(this.sql.replace(/\s+/g, " ").trim());
    const row = this.owner.sqlite
      .prepare(this.sql)
      .get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
}

export interface SqliteD1Options {
  /** Overrides the schema applied at construction. */
  schema?: string;
  /** Reproduces Workerd's SQLITE_LIMIT_COMPOUND_SELECT. Default: unlimited. */
  maxCompoundSelectTerms?: number;
  /** When false the schema is not applied at construction. */
  applySchema?: boolean;
}

export class SqliteD1 {
  readonly sqlite: DatabaseSync;
  readonly executed: string[] = [];
  readonly maxCompoundSelectTerms: number | null;
  beforeNextBatch: (() => void) | null = null;
  failBatchAt: number | null = null;
  failRunMatching: string | null = null;

  constructor(options: SqliteD1Options = {}) {
    this.sqlite = new DatabaseSync(":memory:");
    this.maxCompoundSelectTerms = options.maxCompoundSelectTerms ?? null;
    if (options.applySchema !== false) {
      this.sqlite.exec(options.schema ?? loadSchema());
    }
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<any[]> {
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeBatch?.();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: any[] = [];
      for (let index = 0; index < statements.length; index++) {
        if (this.failBatchAt === index) throw new Error("injected batch failure");
        if (this.failRunMatching && statements[index].sql.includes(this.failRunMatching)) {
          this.failRunMatching = null;
          throw new Error("injected statement failure");
        }
        results.push(await statements[index].run());
      }
      this.failBatchAt = null;
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.failBatchAt = null;
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  count(table: string): number {
    return Number(
      (this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    );
  }

  one<T>(sql: string, ...values: SQLInputValue[]): T {
    return this.sqlite.prepare(sql).get(...values) as T;
  }

  all<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.sqlite.prepare(sql).all(...values) as T[];
  }

  close(): void {
    this.sqlite.close();
  }
}

export type { SQLInputValue };
