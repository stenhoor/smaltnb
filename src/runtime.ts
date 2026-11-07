// Runs a notebook. Each cell is compiled to an async function that receives the names it reads and returns the names
// it defines, plus the value of its last expression (its output). The runtime keeps each cell's state and applies the
// notebook's rules: run modes, guards, cells that wait for inputs that aren't current, and edits to the source.
//
// No database, worker or page here: those wrap this. The TypeScript compiler is passed in, as for parseNotebook.

import { action, cell } from './notebook.js';
import { parseNotebook, type Cell, type Diagnostic, type Notebook, type TypeScript } from './format.js';
import { buildGraph, propagate, type Graph } from './graph.js';

/**
 * - `idle`: has not run.
 * - `running`.
 * - `ok`: ran, and its result is current.
 * - `stale`: its result (if any) is out of date; it waits to be run, or for an input to become current.
 * - `skipped`: its guard, or the guard of a cell it reads, was false; it keeps its last result.
 * - `error`: it failed, or the notebook has an error in it.
 */
export type CellStatus = 'idle' | 'running' | 'ok' | 'stale' | 'skipped' | 'error';

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
}

export type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

export interface RuntimeOptions {
  ts: TypeScript;
  /** Loads the modules the setup cell imports. `smaltnb` itself is built in. In a page: `(s) => import(s)`. */
  importModule?: ModuleLoader;
  fileName?: string;
  /** Called with a copy of a cell's state whenever it changes. */
  onChange?: (state: CellState) => void;
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
const BUILTIN: Record<string, Record<string, unknown>> = { smaltnb: { cell, action } };

export class Runtime {
  #ts: TypeScript;
  #options: RuntimeOptions;
  #source = '';
  #notebook!: Notebook;
  #graph!: Graph;
  #states = new Map<string, CellState>();
  #compiled = new Map<string, Compiled>();
  #signatures = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(source: string, options: RuntimeOptions) {
    this.#ts = options.ts;
    this.#options = options;
    this.#load(source);
  }

  get source(): string { return this.#source; }
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
        await this.#execute(id, false);
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
      for (const id of plan.run) await this.#execute(id, !!options.force && ids.includes(id));
    });
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
      for (const id of plan.run) await this.#execute(id, false);
    });
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
    for (const id of [...this.#states.keys()]) if (!ids.has(id)) this.#states.delete(id);
    this.#signatures.clear();
    for (const c of this.#notebook.cells) {
      const code = c.body ? source.slice(c.body.start, c.body.end) : '';
      this.#signatures.set(c.id, JSON.stringify([c.kind, code, [...c.reads].sort(), c.when?.text ?? null, c.run]));
      if (!this.#states.has(c.id)) {
        this.#states.set(c.id, {
          id: c.id, status: 'idle', reason: null, values: {}, hasOutput: c.output !== null, output: undefined,
          error: null, ms: null, runs: 0,
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

  async #execute(id: string, force: boolean): Promise<void> {
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
    try {
      const r = await compiled.fn(inputs);
      const s = this.#states.get(id)!;
      this.#set(id, { status: 'ok', reason: null, error: null, values: r.values, output: r.output, ms: performance.now() - t0, runs: s.runs + 1 });
    } catch (err) {
      this.#fail(id, err, performance.now() - t0);
    }
  }

  #fail(id: string, err: unknown, ms: number | null = null) {
    const e = err instanceof Error ? err : new Error(String(err));
    this.#set(id, { status: 'error', reason: e.message, error: { message: e.message, ...(e.stack && { stack: e.stack }) }, values: {}, output: undefined, ms });
  }

  #compile(c: Cell): Compiled {
    const code = c.body ? this.#source.slice(c.body.start, c.body.end) : '';
    const key = JSON.stringify([code, c.reads, c.when?.text ?? null]);
    const cached = this.#compiled.get(c.id);
    if (cached?.key === key) return cached;
    const values = c.defines.filter((n) => !c.typeDefines.includes(n));
    const fn = c.kind === 'setup' ? compileSetup(this.#ts, code, this.#options.importModule) : compileCell(this.#ts, code, c.reads, values);
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

function transpile(ts: TypeScript, code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
    reportDiagnostics: false,
  }).outputText;
}

/**
 * A cell's code as an async function: its exports become plain declarations, its last expression is captured as the
 * output, types are stripped, and it returns the values of the names it defines.
 */
function compileCell(ts: TypeScript, code: string, reads: string[], values: string[]): CellFn {
  const sf = ts.createSourceFile('cell.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const edits: { start: number; end: number; text: string }[] = [];
  sf.statements.forEach((st, i) => {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier) {
      edits.push({ start: st.getStart(sf), end: st.getEnd(), text: '' });
      return;
    }
    if (ts.canHaveModifiers(st)) {
      for (const m of ts.getModifiers(st) ?? []) {
        if (m.kind === ts.SyntaxKind.ExportKeyword) edits.push({ start: m.getStart(sf), end: m.getEnd(), text: '' });
      }
    }
    if (i === sf.statements.length - 1 && ts.isExpressionStatement(st)) {
      edits.push({ start: st.expression.getStart(sf), end: st.expression.getEnd(), text: `__nb_out = (${st.expression.getText(sf)})` });
    }
  });
  let edited = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) edited = edited.slice(0, e.start) + e.text + edited.slice(e.end);
  const js = transpile(ts, edited);
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
function compileSetup(ts: TypeScript, code: string, load: ModuleLoader | undefined): CellFn {
  const sf = ts.createSourceFile('setup.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const imports: { spec: string; bind: (m: Record<string, unknown>, out: Record<string, unknown>) => void }[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (clause?.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    imports.push({
      spec,
      bind: (m, out) => {
        if (clause?.name) out[clause.name.text] = m.default;
        const nb = clause?.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) out[nb.name.text] = m;
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue;
            const imported = (el.propertyName ?? el.name).text;
            if (!(imported in m)) throw new Error(`'${spec}' has no export named '${imported}'.`);
            out[el.name.text] = m[imported];
          }
        }
      },
    });
  }
  return async () => {
    const out: Record<string, unknown> = {};
    for (const imp of imports) {
      const m = BUILTIN[imp.spec] ?? (load ? await load(imp.spec) : undefined);
      if (!m) throw new Error(`Can't load '${imp.spec}': no module loader was given.`);
      imp.bind(m, out);
    }
    const values: Record<string, unknown> = {};
    for (const n of Object.keys(out)) values[n] = out[n];
    return { values, output: undefined };
  };
}

function compileGuard(ts: TypeScript, text: string, reads: string[]): GuardFn {
  const js = transpile(ts, `(${text})`).trim().replace(/;$/, '');
  const body = ['"use strict";', reads.length ? `const { ${reads.join(', ')} } = __nb_in;` : '', `return !!(await (${js})());`].join('\n');
  return new AsyncFunction('__nb_in', body) as GuardFn;
}
