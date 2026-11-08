// Runs a notebook. Each cell is compiled to an async function that receives the names it reads and returns the names
// it defines, plus the value of its last expression (its output). The runtime keeps each cell's state and applies the
// notebook's rules: run modes, guards, cells that wait for inputs that aren't current, and edits to the source.
//
// With a database, cells get `db`, `sql` and `exec` (./sql.js): queries and smaltdf frames are collected into TEMP
// tables when their cell finishes, and writes are checked by plan kind (./database.js). No worker or page here: those
// wrap this. smaltty (the TypeScript kit) is passed in, as for parseNotebook.

import { action, cell } from './notebook.js';
import { HeldWrite, NotebookDb, isFrame, type Rows, type WriteContext } from './database.js';
import * as sqlModule from './sql.js';
import { md } from './md.js';
import { createParam, type ParamInfo, type ParamSpec } from './params.js';
import { Relation, SqlQuery, registerCollected, statement, type CollectedTable } from './sql.js';
import { importSpecifiers, moduleOf, parseNotebook, type Cell, type Diagnostic, type Notebook, type TypeScriptKit } from './format.js';
import { buildGraph, propagate, type Graph } from './graph.js';

/**
 * - `idle`: has not run.
 * - `running`.
 * - `ok`: ran, and its result is current.
 * - `stale`: its result (if any) is out of date; it waits to be run, or for an input to become current.
 * - `skipped`: its guard, or the guard of a cell it reads, was false; it keeps its last result.
 * - `held`: it tried to write to the database without being an action or run on request; it keeps its last result.
 * - `error`: it failed, or the notebook has an error in it.
 */
export type CellStatus = 'idle' | 'running' | 'ok' | 'stale' | 'skipped' | 'held' | 'error';

export interface CellState {
  id: string;
  status: CellStatus;
  /** Why the cell is stale, skipped or failed, in words; null otherwise. */
  reason: string | null;
  /** The names the cell defines, from its last successful run. */
  values: Record<string, unknown>;
  /** Whether the cell ends with an expression, so `output` is meaningful. */
  hasOutput: boolean;
  /** The value of the cell's last expression, from its last successful run. */
  output: unknown;
  error: { message: string; stack?: string } | null;
  /** How long the last run took, in milliseconds. */
  ms: number | null;
  /** How many times the cell has run successfully. */
  runs: number;
  /** When the output is a collected result: its table, and its first rows. */
  outputTable: (CollectedTable & { preview: Rows }) | null;
}

export type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

export interface RuntimeOptions {
  /** smaltty, the TypeScript kit: `smaltty` from smaltkit/typescript. */
  ts: TypeScriptKit;
  /** Loads the modules the setup cell imports. `smaltnb` itself is built in. In a page: `(s) => import(s)`. */
  importModule?: ModuleLoader;
  fileName?: string;
  /** Called with a copy of a cell's state whenever it changes. */
  onChange?: (state: CellState) => void;
  /**
   * The notebook's database: a smaltdb `Database`, in process (smaltdb/engine) or the worker client (smaltdb), with
   * smaltql and smaltdf registered. Without one, `db`, `sql` results and `exec` fail with a message.
   */
  database?: unknown;
  /**
   * Turns a collected table into what later cells read: smaltdf's `table(name)`, so frame methods chain on a SQL
   * result. Without it they read a `Relation`.
   */
  frame?: (table: string) => object;
  /** Rows of a collected output sent with the cell's state (the rest are fetched with `rows`). Default 50. */
  previewRows?: number;
  /** Parameter values from outside, as text (a URL's query, a headless run's arguments). */
  params?: Record<string, string>;
  /** Called with the notebook's parameters whenever they change: declared, removed, or given a new value. */
  onParams?: (params: ParamInfo[]) => void;
}

export interface RunOptions {
  /** Run even if the cell's guard is false ("Run once anyway"). */
  force?: boolean;
}

export interface RunAllOptions {
  /** Also run actions, once each, in order (a headless run). Default false: actions run only on request. */
  actions?: boolean;
}

type CellFn = (inputs: Record<string, unknown>) => Promise<{ values: Record<string, unknown>; output: unknown }>;
type GuardFn = (inputs: Record<string, unknown>) => Promise<boolean>;

interface Compiled {
  key: string;
  fn: CellFn;
  guard: GuardFn | null;
}

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/** A collected table's name: per cell and name, readable in the database's TEMP tables. */
function tableName(cell: string, name: string): string {
  return `nb_${cell.replace(/[^A-Za-z0-9_]+/g, '_')}_${name}`;
}

export class Runtime {
  #ts: TypeScriptKit;
  #options: RuntimeOptions;
  #source = '';
  #notebook!: Notebook;
  #graph!: Graph;
  #states = new Map<string, CellState>();
  #compiled = new Map<string, Compiled>();
  #signatures = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();
  #db: NotebookDb | null;
  #context: WriteContext | null = null;
  #tables = new Map<string, Set<string>>();
  #builtins: Record<string, Record<string, unknown>>;
  #paramValues: Map<string, string>;
  #paramInfo = new Map<string, ParamInfo>();
  #paramsSent = '[]';

  constructor(source: string, options: RuntimeOptions) {
    this.#ts = options.ts;
    this.#options = options;
    this.#db = options.database ? new NotebookDb(options.database, () => this.#context) : null;
    const noDb = () => { throw new Error('This notebook has no database.'); };
    this.#builtins = {
      smaltnb: {
        ...sqlModule,
        md,
        cell,
        action,
        param: createParam((name, spec) => this.#resolveParam(name, spec)),
        db: this.#db ? this.#db.handle() : new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : noDb()) }),
        exec: (strings: TemplateStringsArray, ...values: unknown[]) =>
          this.#db ? this.#db.exec(statement(strings, values)) : Promise.reject(new Error('This notebook has no database.')),
      },
    };
    this.#paramValues = new Map(Object.entries(options.params ?? {}));
    this.#load(source);
  }

  get source(): string { return this.#source; }

  /** The notebook's parameters, as declared by the cells that have run, with their values in use. */
  params(): ParamInfo[] {
    return [...this.#paramInfo.values()].map((p) => ({ ...p, ...(p.choices && { choices: [...p.choices] }) }));
  }

  /**
   * Sets parameter values, as text (null goes back to the default). The cells that declare them run again, and what
   * reads them reacts as to an edit. A value that doesn't fit is an error on the declaring cell.
   */
  setParams(values: Record<string, string | null>): Promise<void> {
    return this.#enqueue(async () => {
      for (const [name, value] of Object.entries(values)) {
        if (value === null) this.#paramValues.delete(name);
        else this.#paramValues.set(name, value);
      }
      const cells = [...new Set(Object.keys(values).map((n) => this.#paramInfo.get(n)?.cell).filter((c): c is string => !!c && this.#graph.byId.has(c)))];
      if (!cells.length) return;
      const plan = propagate(this.#graph, [], { run: cells });
      this.#markStale(plan.stale, 'a parameter changed');
      for (const id of plan.run) await this.#execute(id, false, false);
    });
  }

  #resolveParam<T>(name: string, spec: ParamSpec<T>): T {
    const cell = this.#context?.cell ?? '';
    const other = this.#paramInfo.get(name);
    if (other && other.cell !== cell) throw new Error(`Parameter "${name}" is already declared in cell "${other.cell}".`);
    const text = this.#paramValues.get(name);
    const info = (value: string, error?: string): ParamInfo => ({
      name, kind: spec.kind, default: String(spec.default), value, cell,
      ...(spec.choices && { choices: [...spec.choices] }), ...(error !== undefined && { error }),
    });
    let value: T;
    try {
      value = text === undefined ? spec.default : spec.parse(text);
    } catch (err) {
      // Recorded with the value that didn't fit, so the page shows it and setParams finds the cell to rerun.
      const message = err instanceof Error ? err.message : String(err);
      this.#paramInfo.set(name, info(text!, message));
      throw new Error(`Parameter "${name}": ${message}`);
    }
    this.#paramInfo.set(name, info(String(value)));
    return value;
  }

  /** Tells onParams when the parameters changed. */
  #sendParams() {
    const now = JSON.stringify(this.params());
    if (now === this.#paramsSent) return;
    this.#paramsSent = now;
    this.#options.onParams?.(this.params());
  }
  get notebook(): Notebook { return this.#notebook; }
  get graph(): Graph { return this.#graph; }
  get diagnostics(): Diagnostic[] { return this.#graph.diagnostics; }

  /** A copy of a cell's state. */
  state(id: string): CellState | undefined {
    const s = this.#states.get(id);
    return s && { ...s };
  }

  /** Copies of every cell's state, in file order. */
  states(): CellState[] {
    return this.#notebook.cells.map((c) => ({ ...this.#states.get(c.id)! }));
  }

  /** The current value of a top-level name, from the cell that defines it. */
  value(name: string): unknown {
    const owner = this.#notebook.cells.find((c) => c.defines.includes(name));
    return owner ? this.#states.get(owner.id)!.values[name] : undefined;
  }

  /** Runs every cell in order: all run modes, and actions only when asked. */
  runAll(options: RunAllOptions = {}): Promise<void> {
    return this.#enqueue(async () => {
      for (const id of this.#graph.order) {
        if (this.#cell(id).kind === 'action' && !options.actions) continue;
        await this.#execute(id, false, false);
      }
    });
  }

  /**
   * Runs these cells on request, whatever their run mode, then what follows from them: `auto` cells downstream run,
   * the others go stale.
   */
  run(ids: string[], options: RunOptions = {}): Promise<void> {
    return this.#enqueue(async () => {
      for (const id of ids) this.#cell(id);
      const plan = propagate(this.#graph, [], { run: ids });
      this.#markStale(plan.stale, 'an input changed');
      for (const id of plan.run) await this.#execute(id, !!options.force && ids.includes(id), ids.includes(id));
    });
  }

  /** A window of a cell's collected output (for a grid that scrolls), or of one of its collected names. */
  async rows(cell: string, offset: number, limit: number, name?: string): Promise<Rows> {
    const s = this.#states.get(cell);
    if (!s) throw new Error(`No cell named "${cell}".`);
    const table = name === undefined ? s.outputTable?.table : sqlModule.collectedTable(s.values[name])?.table;
    if (!table || !this.#db) throw new Error(`Cell "${cell}" has no collected ${name === undefined ? 'output' : `"${name}"`}.`);
    return this.#db.rows(table, offset, limit);
  }

  /**
   * Replaces the source (an edit). Cells whose code, reads or guard changed are treated as changed: `auto` cells
   * among them and downstream run, the others go stale. Removed cells are dropped.
   */
  update(source: string): Promise<void> {
    return this.#enqueue(async () => {
      const before = new Map(this.#signatures);
      this.#load(source);
      const changed = this.#notebook.cells.filter((c) => before.get(c.id) !== this.#signatures.get(c.id)).map((c) => c.id);
      if (!changed.length) return;
      const plan = propagate(this.#graph, changed);
      for (const id of plan.stale) {
        const reason = this.#cell(id).kind === 'action' ? 'inputs changed since last run'
          : changed.includes(id) ? 'edited, not run' : 'an input changed';
        this.#markStale([id], reason);
      }
      for (const id of plan.run) await this.#execute(id, false, false);
    }).finally(() => this.#sendParams());
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => {});
    return next;
  }

  #cell(id: string): Cell {
    const c = this.#graph.byId.get(id);
    if (!c) throw new Error(`No cell named "${id}".`);
    return c;
  }

  #load(source: string) {
    this.#source = source;
    this.#notebook = parseNotebook(source, this.#ts, { fileName: this.#options.fileName });
    this.#graph = buildGraph(this.#notebook);
    const ids = new Set(this.#notebook.cells.map((c) => c.id));
    for (const id of [...this.#states.keys()]) {
      if (ids.has(id)) continue;
      this.#states.delete(id);
      for (const [name, p] of [...this.#paramInfo]) if (p.cell === id) this.#paramInfo.delete(name);
      void this.#dropTables(id, new Set());
    }
    this.#signatures.clear();
    for (const c of this.#notebook.cells) {
      const code = c.body ? source.slice(c.body.start, c.body.end) : '';
      this.#signatures.set(c.id, JSON.stringify([c.kind, code, [...c.reads].sort(), c.when?.text ?? null, c.run]));
      if (!this.#states.has(c.id)) {
        this.#states.set(c.id, {
          id: c.id, status: 'idle', reason: null, values: {}, hasOutput: c.output !== null, output: undefined,
          error: null, ms: null, runs: 0, outputTable: null,
        });
      }
      this.#states.get(c.id)!.hasOutput = c.output !== null;
    }
  }

  #set(id: string, patch: Partial<CellState>) {
    const s = this.#states.get(id)!;
    Object.assign(s, patch);
    this.#options.onChange?.({ ...s });
  }

  #markStale(ids: string[], reason: string) {
    for (const id of ids) if (this.#states.get(id)!.status !== 'idle') this.#set(id, { status: 'stale', reason });
  }

  /**
   * Runs one cell if it can run now. `force` ignores its guard; `requested` means it was run on request (a Run
   * button), which lets a cell that isn't an action write.
   */
  async #execute(id: string, force: boolean, requested: boolean): Promise<void> {
    const c = this.#cell(id);
    const errors = this.#graph.diagnostics.filter((d) => d.cell === id && d.severity === 'error');
    if (errors.length) {
      this.#set(id, { status: 'error', reason: errors[0]!.message, error: { message: errors.map((d) => d.message).join('\n') } });
      return;
    }
    for (const e of this.#graph.edges) {
      if (e.to !== id) continue;
      const up = this.#states.get(e.from)!;
      if (up.status === 'skipped') { this.#set(id, { status: 'skipped', reason: `"${e.from}" was skipped` }); return; }
      if (up.status !== 'ok') {
        if (this.#states.get(id)!.status !== 'idle' || up.status === 'error') this.#set(id, { status: 'stale', reason: `waiting for "${e.from}"` });
        return;
      }
    }
    const inputs: Record<string, unknown> = {};
    for (const name of new Set([...c.reads, ...c.when?.reads ?? []])) inputs[name] = this.value(name);

    let compiled: Compiled;
    try {
      compiled = this.#compile(c);
    } catch (err) {
      this.#fail(id, err);
      return;
    }
    if (compiled.guard && !force) {
      let pass: boolean;
      try {
        pass = await compiled.guard(inputs);
      } catch (err) {
        this.#fail(id, err);
        return;
      }
      if (!pass) { this.#set(id, { status: 'skipped', reason: `when ${c.when!.text} is false` }); return; }
    }
    this.#set(id, { status: 'running', reason: null });
    const t0 = performance.now();
    this.#context = { cell: id, allowWrites: c.kind === 'action' || requested };
    for (const [name, p] of [...this.#paramInfo]) if (p.cell === id) this.#paramInfo.delete(name);
    try {
      const r = await compiled.fn(inputs);
      this.#context = null;
      const collected = c.live || c.kind === 'setup' ? { values: r.values, output: r.output, outputTable: null } : await this.#collect(id, r.values, r.output);
      const s = this.#states.get(id)!;
      this.#set(id, {
        status: 'ok', reason: null, error: null, values: collected.values, output: collected.output,
        outputTable: collected.outputTable, ms: performance.now() - t0, runs: s.runs + 1,
      });
    } catch (err) {
      this.#context = null;
      if (err instanceof HeldWrite) this.#set(id, { status: 'held', reason: err.message, ms: performance.now() - t0 });
      else this.#fail(id, err, performance.now() - t0);
    } finally {
      this.#sendParams();
    }
  }

  /**
   * Collects the cell's queries and smaltdf frames into TEMP tables (DESIGN.md decision 12): later cells read the
   * collected rows, as a frame over the table (with `frame`) or a `Relation`.
   */
  async #collect(id: string, values: Record<string, unknown>, output: unknown) {
    const kept = new Set<string>();
    const replaced = new Map<unknown, unknown>();
    const out: Record<string, unknown> = { ...values };
    const one = async (value: unknown, table: string) => {
      if (replaced.has(value)) return replaced.get(value);
      if (!(value instanceof SqlQuery) && !isFrame(value)) return value;
      if (!this.#db) throw new Error('This notebook has no database to run its queries.');
      const info = value instanceof SqlQuery ? await this.#db.collectQuery(value, table) : await this.#db.collectFrame(value, table);
      const result = this.#options.frame ? this.#options.frame(table) : new Relation(info);
      registerCollected(result, info);
      kept.add(table);
      replaced.set(value, result);
      return result;
    };
    for (const [name, value] of Object.entries(values)) out[name] = await one(value, tableName(id, name));
    const collectedOutput = await one(output, tableName(id, '_output'));
    await this.#dropTables(id, kept);
    const info = sqlModule.collectedTable(collectedOutput);
    const outputTable = info && this.#db
      ? { ...info, preview: await this.#db.rows(info.table, 0, this.#options.previewRows ?? 50) }
      : null;
    return { values: out, output: collectedOutput, outputTable };
  }

  /** Drops the cell's collected tables that it no longer has. */
  async #dropTables(id: string, keep: Set<string>) {
    const old = this.#tables.get(id) ?? new Set<string>();
    if (this.#db) for (const t of old) if (!keep.has(t)) await this.#db.drop(t);
    if (keep.size) this.#tables.set(id, keep);
    else this.#tables.delete(id);
  }

  #fail(id: string, err: unknown, ms: number | null = null) {
    const e = err instanceof Error ? err : new Error(String(err));
    this.#set(id, { status: 'error', reason: e.message, error: { message: e.message, ...(e.stack && { stack: e.stack }) }, values: {}, output: undefined, outputTable: null, ms });
  }

  #compile(c: Cell): Compiled {
    const code = c.body ? this.#source.slice(c.body.start, c.body.end) : '';
    const key = JSON.stringify([code, c.reads, c.when?.text ?? null]);
    const cached = this.#compiled.get(c.id);
    if (cached?.key === key) return cached;
    const values = c.defines.filter((n) => !c.typeDefines.includes(n));
    // The code is compiled where it is in the notebook (blank lines and columns before it), so a syntax error, or code
    // that can't be stripped, gives the notebook's line and column.
    const start = c.body?.start ?? 0;
    const placed = '\n'.repeat(c.body ? c.body.line - 1 : 0) + ' '.repeat(start - (this.#source.lastIndexOf('\n', start - 1) + 1)) + code;
    const fileName = this.#options.fileName ?? 'notebook.nb.ts';
    const fn = c.kind === 'setup' ? compileSetup(this.#ts, placed, this.#builtins, this.#options.importModule, fileName) : compileCell(this.#ts, placed, c.reads, values, fileName);
    const guard = c.when ? compileGuard(this.#ts, c.when.text, c.when.reads) : null;
    const compiled = { key, fn, guard };
    this.#compiled.set(c.id, compiled);
    return compiled;
  }
}

/** Creates a runtime for a notebook's source. Nothing runs until `runAll`, `run` or `update`. */
export function createRuntime(source: string, options: RuntimeOptions): Runtime {
  return new Runtime(source, options);
}

/**
 * A cell's code as an async function: its exports become plain declarations, its last expression is captured as the
 * output, types are stripped (to spaces, so lines and columns stay), and it returns the values of the names it defines.
 */
function compileCell(ts: TypeScriptKit, code: string, reads: string[], values: string[], fileName: string): CellFn {
  const t = ts.parse(code, { fileName });
  const edits: { start: number; end: number; text: string }[] = [];
  const statements = t.children(t.root);
  statements.forEach((st, i) => {
    const kind = t.kind[st]!;
    if (kind === ts.K.ExportDeclaration && !t.children(st).some((c) => t.kind[c] === ts.K.StringLiteral)) {
      edits.push({ start: t.start[st]!, end: t.end[st]!, text: '' });
      return;
    }
    // `export` is a declaration's first token (modifiers come before the rest).
    if (t.flags[st]! & ts.F.Export && code.startsWith('export', t.start[st]!)) {
      edits.push({ start: t.start[st]!, end: t.start[st]! + 6, text: '      ' });
    }
    if (i === statements.length - 1 && kind === ts.K.ExpressionStatement) {
      const e = t.first[st]!;
      edits.push({ start: t.start[e]!, end: t.end[e]!, text: `__nb_out = (${t.textOf(e)})` });
    }
  });
  let edited = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) edited = edited.slice(0, e.start) + e.text + edited.slice(e.end);
  const js = ts.strip(edited, { fileName });
  const body = [
    '"use strict";',
    reads.length ? `const { ${reads.join(', ')} } = __nb_in;` : '',
    'let __nb_out;',
    js,
    `return { values: { ${values.join(', ')} }, output: __nb_out };`,
  ].join('\n');
  return new AsyncFunction('__nb_in', body) as CellFn;
}

/** The setup cell's imports, loaded with the module loader (`smaltnb` is built in). Type-only imports are dropped. */
function compileSetup(ts: TypeScriptKit, code: string, builtins: Record<string, Record<string, unknown>>, load: ModuleLoader | undefined, fileName: string): CellFn {
  const t = ts.parse(code, { fileName });
  const imports: { spec: string; bind: (m: Record<string, unknown>, out: Record<string, unknown>) => void }[] = [];
  for (const st of t.children(t.root)) {
    if (t.kind[st] !== ts.K.ImportDeclaration) continue;
    const names = importSpecifiers(t, ts, st).filter((n) => !n.typeOnly);
    const clause = t.children(st).find((c) => t.kind[c] === ts.K.ImportClause);
    if (clause && t.flags[clause]! & ts.F.TypeOnly) continue; // import type …: nothing to load
    const spec = moduleOf(t, ts, st);
    imports.push({
      spec,
      bind: (m, out) => {
        for (const n of names) {
          if (n.imported === 'default') out[n.local] = m.default;
          else if (n.imported === '*') out[n.local] = m;
          else {
            if (!(n.imported in m)) throw new Error(`'${spec}' has no export named '${n.imported}'.`);
            out[n.local] = m[n.imported];
          }
        }
      },
    });
  }
  return async () => {
    const out: Record<string, unknown> = {};
    for (const imp of imports) {
      const m = builtins[imp.spec] ?? (load ? await load(imp.spec) : undefined);
      if (!m) throw new Error(`Can't load '${imp.spec}': no module loader was given.`);
      imp.bind(m, out);
    }
    const values: Record<string, unknown> = {};
    for (const n of Object.keys(out)) values[n] = out[n];
    return { values, output: undefined };
  };
}

function compileGuard(ts: TypeScriptKit, text: string, reads: string[]): GuardFn {
  const js = ts.strip(`(${text})`, { fileName: 'guard.ts' }).trim().replace(/;$/, '');
  const body = ['"use strict";', reads.length ? `const { ${reads.join(', ')} } = __nb_in;` : '', `return !!(await (${js})());`].join('\n');
  return new AsyncFunction('__nb_in', body) as GuardFn;
}
