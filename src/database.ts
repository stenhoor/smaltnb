// The notebook's side of the database: the handle cells get as `db`, which checks every statement before it runs; and
// the runtime's own work, collecting results into TEMP tables and reading their rows.
//
// A side effect is defined by plan kind, whatever language the statement comes from (DESIGN.md decision 7): a plan
// whose kind isn't a query is a write. SQL text is classified by the engine (`prepare(sql).readonly`) where the engine
// says so. Through the worker client it doesn't yet: there `exec` counts as a write and a query as a read.
//
// Works with smaltdb's in-process engine (`Database` from smaltdb/engine) and its worker client (`Database` from
// smaltdb). Imports nothing from smaltdb: the database object is given by the host.

import { quoteIdentifier, type CollectedTable, type ExecResult, type SqlParam, type SqlQuery, type SqlStatement } from './sql.js';

/** A write in a cell that may not write now: it is held until the cell is run on request or marked as an action. */
export class HeldWrite extends Error {
  constructor(what: string) {
    super(`${what} writes to the database. Run the cell to let it write, or mark it as an action.`);
    this.name = 'HeldWrite';
  }
}

/** Who is running, and whether they may write: supplied by the runtime for each cell run. */
export interface WriteContext {
  cell: string;
  allowWrites: boolean;
}

// The engine and the client have the same method names with different signatures; this module checks which it has.
type Raw = Record<string, any>;

const READ_KINDS = new Set(['query', 'explain']);
const NEUTRAL_KINDS = new Set(['transaction']);

/** Whether a statement given as plan data writes: anything that isn't a query (a bare plan operation is a query). */
export function planWrites(stmt: unknown): boolean {
  if (!stmt || typeof stmt !== 'object') return false;
  if ('op' in stmt) return false;
  const kind = (stmt as { kind?: unknown }).kind;
  return typeof kind === 'string' && !READ_KINDS.has(kind) && !NEUTRAL_KINDS.has(kind);
}

const DECLARED: Record<string, string> = { int: 'INTEGER', bool: 'INTEGER', real: 'REAL', num: 'NUMERIC', text: 'TEXT', blob: 'BLOB' };

export interface Rows {
  columns: string[];
  rows: unknown[][];
}

export class NotebookDb {
  /** The database object the host gave: an engine or a client `Database`. */
  readonly raw: Raw;
  /** The in-process engine (synchronous, with `readonly` on statements) rather than the worker client. */
  readonly inProcess: boolean;
  #context: () => WriteContext | null;

  constructor(raw: unknown, context: () => WriteContext | null) {
    this.raw = raw as Raw;
    this.inProcess = typeof this.raw.queryPlanAsync === 'function';
    this.#context = context;
  }

  /** Whether SQL text writes: true or false when the engine says, null when it can't. */
  async sqlWrites(text: string): Promise<boolean | null> {
    if (this.inProcess) {
      if (typeof this.raw.isScript === 'function' && this.raw.isScript(text)) return true;
      return !this.raw.prepare(text).readonly;
    }
    const stmt = await this.raw.prepare(text);
    try {
      return typeof stmt.readonly === 'boolean' ? !stmt.readonly : null;
    } finally {
      await stmt.finalize?.();
    }
  }

  #check(writes: boolean, what: string) {
    const ctx = this.#context();
    if (writes && ctx && !ctx.allowWrites) throw new HeldWrite(what);
  }

  /** Runs a query, unchecked: the runtime's own reads. */
  async query(text: string, params: readonly SqlParam[] = []): Promise<Rows & { columnTypes: string[] }> {
    const r = this.inProcess ? this.raw.query(text, params) : await this.raw.query(text, params, { rowMode: 'array' });
    return { columns: r.columns, rows: r.rows, columnTypes: r.columnTypes ?? r.columns.map(() => 'any') };
  }

  /** Runs statements, unchecked: the runtime's own writes (its TEMP tables). */
  async run(text: string, params: readonly SqlParam[] = []): Promise<number> {
    if (this.inProcess) {
      if (this.raw.isScript?.(text)) { this.raw.exec(text, params); return 0; }
      return this.raw.run(text, params).changes ?? 0;
    }
    return (await this.raw.exec(text, params)).changes ?? 0;
  }

  /** The columns and types a query gives, without running it. */
  async describe(text: string): Promise<{ columns: string[]; columnTypes: string[] }> {
    const stmt = this.inProcess ? this.raw.prepare(text) : await this.raw.prepare(text);
    try {
      return { columns: [...stmt.columns], columnTypes: [...(stmt.columnTypes ?? stmt.columns.map(() => 'any'))] };
    } finally {
      if (!this.inProcess) await stmt.finalize?.();
    }
  }

  /** The columns and types a plan gives, without running it. */
  async describePlan(plan: unknown): Promise<{ columns: string[]; columnTypes: string[] }> {
    const stmt = this.inProcess ? this.raw.preparePlan(plan) : await this.raw.preparePlan(plan);
    return { columns: [...stmt.columns], columnTypes: [...(stmt.columnTypes ?? stmt.columns.map(() => 'any'))] };
  }

  /** `exec` for cells: checked, then run. A statement whose kind the engine can't tell counts as a write. */
  async exec(stmt: SqlStatement): Promise<ExecResult> {
    this.#check((await this.sqlWrites(stmt.text)) ?? true, 'This statement');
    return { rows: await this.run(stmt.text, stmt.params) };
  }

  /** The database as cells see it: every statement checked before it runs. */
  handle(): Raw {
    return this.#guard(this.raw);
  }

  #guard(target: Raw): Raw {
    const self = this;
    return new Proxy(target, {
      get(t, key, receiver) {
        const value = Reflect.get(t, key, receiver);
        if (typeof value !== 'function') return value;
        const fn = value.bind(t) as (...args: any[]) => any;
        switch (key) {
          case 'queryPlan':
          case 'queryPlanAsync':
          case 'streamPlan':
          case 'preparePlan':
            return (stmt: unknown, ...rest: unknown[]) => {
              self.#check(planWrites(stmt), 'A plan');
              return fn(stmt, ...rest);
            };
          case 'query':
            return async (text: string, params?: readonly SqlParam[]) => {
              self.#check((await self.sqlWrites(text)) ?? false, 'This query');
              const r = await self.query(text, params ?? []);
              return { columns: r.columns, rows: r.rows };
            };
          case 'exec':
          case 'run':
            return async (text: string, params?: readonly SqlParam[]) => {
              self.#check((await self.sqlWrites(text)) ?? true, 'This statement');
              return fn(text, params);
            };
          case 'transaction':
            return (body: (tx: Raw) => unknown, ...rest: unknown[]) =>
              fn((tx: Raw) => body(tx && typeof tx === 'object' ? self.#guard(tx) : tx), ...rest);
          default:
            return fn;
        }
      },
    });
  }

  /** Collects a query's rows into a TEMP table. */
  async collectQuery(query: SqlQuery, table: string): Promise<CollectedTable> {
    const shape = await this.describe(query.text);
    await this.#create(table, shape.columns, shape.columnTypes);
    await this.run(`INSERT INTO temp.${quoteIdentifier(table)} ${query.text}`, query.params);
    return this.#info(table, shape.columns, shape.columnTypes);
  }

  /** Collects a smaltdf frame's rows into a TEMP table: the rows move inside the engine, not through the kernel. */
  async collectFrame(frame: FrameLike, table: string): Promise<CollectedTable> {
    const shape = await this.describePlan(await frame.plan(this.raw));
    await this.#create(table, shape.columns, shape.columnTypes);
    await frame.insertInto(this.raw, table);
    return this.#info(table, shape.columns, shape.columnTypes);
  }

  /** A window of a collected table's rows. */
  async rows(table: string, offset: number, limit: number): Promise<Rows> {
    const r = await this.query(`SELECT * FROM temp.${quoteIdentifier(table)} LIMIT ?1 OFFSET ?2`, [limit, offset]);
    return { columns: r.columns, rows: r.rows };
  }

  /** Drops a collected table, if it exists. */
  async drop(table: string): Promise<void> {
    await this.run(`DROP TABLE IF EXISTS temp.${quoteIdentifier(table)}`);
  }

  async #create(table: string, columns: string[], types: string[]) {
    await this.drop(table);
    const cols = columns.map((c, i) => `${quoteIdentifier(c)} ${DECLARED[types[i] ?? ''] ?? 'ANY'}`).join(', ');
    await this.run(`CREATE TEMP TABLE ${quoteIdentifier(table)} (${cols})`);
  }

  async #info(table: string, columns: string[], columnTypes: string[]): Promise<CollectedTable> {
    const n = await this.query(`SELECT count(*) FROM temp.${quoteIdentifier(table)}`);
    return { table, columns, columnTypes, rowCount: Number(n.rows[0]![0]) };
  }
}

/** What the runtime needs of a smaltdf frame to collect it. */
export interface FrameLike {
  plan(db: unknown): Promise<unknown>;
  insertInto(db: unknown, table: string): Promise<unknown>;
}

/** Whether a value is a smaltdf frame (or anything with a frame's plan and insertInto). */
export function isFrame(value: unknown): value is FrameLike {
  if (!value || typeof value !== 'object') return false;
  try {
    return typeof (value as FrameLike).plan === 'function' && typeof (value as FrameLike).insertInto === 'function';
  } catch {
    return false; // a proxy that throws on access, such as db without a database
  }
}
