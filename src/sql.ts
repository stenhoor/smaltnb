// SQL in a notebook. `sql` builds a query; the runtime runs it when the cell finishes and collects its rows, so later
// cells read the result (DESIGN.md decisions 10-12). `exec` runs a statement at once. `db` is the notebook's database.
//
// Inside both tags, `${value}` is a bound parameter, `${result}` (another cell's collected result) is that result's
// table, and `${sql.id(name)}` is an identifier. Values are never spliced into the text.
//
// `exec` and `db` only work inside a running notebook: the runtime supplies them.

/** What a query's rows look like, for TypeScript: pinned in the source by the editor (`sql<Order>`…``). */
export type Row = Record<string, unknown>;

/** A query, not yet run: the runtime collects it when its cell finishes. */
export class SqlQuery<R extends Row = Row> {
  readonly text: string;
  readonly params: readonly SqlParam[];
  /** @internal The row type, for TypeScript only. */
  declare readonly __row?: R;
  constructor(text: string, params: readonly SqlParam[]) {
    this.text = text;
    this.params = params;
  }
}

/** A statement for `exec`. */
export class SqlStatement {
  readonly text: string;
  readonly params: readonly SqlParam[];
  constructor(text: string, params: readonly SqlParam[]) {
    this.text = text;
    this.params = params;
  }
}

/** An identifier for `${}`: quoted, never a parameter. */
export class SqlIdentifier {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

/** A value a statement can take as a parameter. */
export type SqlParam = number | bigint | string | boolean | null | Uint8Array;

/** A cell's collected result as a table: what `${}` in SQL refers to when it is given a collected value. */
export interface CollectedTable {
  /** The table's name, in the notebook's TEMP tables. */
  table: string;
  columns: string[];
  columnTypes: string[];
  rowCount: number;
}

/** The collected value of a cell: a table of rows, read by later cells. Returned when no frame type is configured. */
export class Relation implements CollectedTable {
  readonly table: string;
  readonly columns: string[];
  readonly columnTypes: string[];
  readonly rowCount: number;
  constructor(info: CollectedTable) {
    this.table = info.table;
    this.columns = info.columns;
    this.columnTypes = info.columnTypes;
    this.rowCount = info.rowCount;
  }
}

// Values the runtime collected, by object: lets `${clean}` name clean's table even when clean is a smaltdf frame.
const collected = new WeakMap<object, CollectedTable>();

/** @internal Records that a value is the collected result held in a table. */
export function registerCollected(value: object, info: CollectedTable): void {
  collected.set(value, info);
}

/** The table a collected value is held in, if it is one. */
export function collectedTable(value: unknown): CollectedTable | undefined {
  return value !== null && typeof value === 'object' ? collected.get(value) : undefined;
}

/** Quotes an identifier for SQL. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function build(strings: TemplateStringsArray, values: unknown[]): { text: string; params: SqlParam[] } {
  let text = strings[0]!;
  const params: SqlParam[] = [];
  values.forEach((v, i) => {
    let part: string;
    if (v instanceof SqlIdentifier) part = quoteIdentifier(v.name);
    else if (collectedTable(v)) part = `temp.${quoteIdentifier(collectedTable(v)!.table)}`;
    else if (isParam(v)) {
      params.push(v);
      part = `?${params.length}`;
    } else if (v === undefined) {
      throw new TypeError(`sql: \${} number ${i + 1} is undefined.`);
    } else if (v !== null && typeof v === 'object') {
      throw new TypeError(
        `sql: \${} number ${i + 1} is ${(v as object).constructor?.name ?? 'an object'}, not a collected result or a value. ` +
        'Only results that were collected (not live) can be read from SQL.',
      );
    } else {
      throw new TypeError(`sql: \${} number ${i + 1} can't be a parameter (${typeof v}).`);
    }
    text += part + strings[i + 1]!;
  });
  return { text, params };
}

function isParam(v: unknown): v is SqlParam {
  return v === null || v instanceof Uint8Array || ['number', 'bigint', 'string', 'boolean'].includes(typeof v);
}

interface SqlTag {
  <R extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery<R>;
  /** An identifier (a table or column name) for `${}`. */
  id(name: string): SqlIdentifier;
}

/** A query. The runtime runs it when the cell finishes and collects its rows for later cells. */
export const sql: SqlTag = Object.assign(
  <R extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery<R> => {
    const { text, params } = build(strings, values);
    return new SqlQuery<R>(text, params);
  },
  { id: (name: string) => new SqlIdentifier(name) },
);

/** @internal Builds a statement from a template: used by `exec`. */
export function statement(strings: TemplateStringsArray, values: unknown[]): SqlStatement {
  const { text, params } = build(strings, values);
  return new SqlStatement(text, params);
}

/** What a statement run with `exec` changed. */
export interface ExecResult {
  /** Rows written, changed or deleted. */
  rows: number;
}

/**
 * The notebook's database, as cells see it: pass it to smaltdf (`frame.insertInto(db, 'orders')`), or query it.
 * Writes go through the same checks as `exec`: in a cell that isn't an action they are held until you run the cell.
 */
export interface NotebookDatabase {
  /** The engine's catalog, as smaltdf reads it. */
  readonly catalog: unknown;
  /** Runs a statement given as plan data (how smaltdf runs frames). */
  queryPlan(stmt: unknown, params?: readonly unknown[], options?: unknown): Promise<unknown>;
  /** Runs one SQL query and returns its rows as arrays. */
  query(sql: string, params?: readonly SqlParam[]): Promise<{ columns: string[]; rows: unknown[][] }>;
}

const outside = (what: string) => new Error(`${what} only works inside a running notebook.`);

/** Runs a statement at once (an `INSERT`, a `CREATE TABLE`, …). In a cell that isn't an action, it is held. */
export async function exec(strings: TemplateStringsArray, ...values: unknown[]): Promise<ExecResult> {
  void statement(strings, values);
  throw outside('exec');
}

/** The notebook's database. Supplied by the runtime when the notebook runs. */
export const db: NotebookDatabase = new Proxy({} as NotebookDatabase, {
  get(_target, key) {
    if (key === 'then') return undefined;
    throw outside(`db.${String(key)}`);
  },
});
