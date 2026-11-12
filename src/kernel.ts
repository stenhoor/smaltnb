// The kernel: the runtime (./runtime.js) served over messages, to run in a Web Worker. Cell code runs there, off the
// page, so a cell that never finishes can be stopped by replacing the worker (see ./client.js), and the database,
// which has its own worker, is not touched.
//
// In the app's worker file:
//
//   import { serveKernel } from 'smaltnb/kernel';
//   import { smaltty } from 'smaltkit/typescript';
//   import { open } from 'smaltql';
//   import { table } from '@smaltdb/df';
//   serveKernel(self, { ts: smaltty, importModule: (spec) => import(spec), database: () => open('notebook'), frame: table });

import { parseNotebook, type Cell, type Diagnostic, type TypeScriptKit } from './format.js';
import { buildGraph, type Edge } from './graph.js';
import { createRuntime, type CellState, type ModuleLoader, type Runtime } from './runtime.js';
import type { Rows } from './database.js';
import type { CollectedTable } from './sql.js';
import { Markdown } from './md.js';
import type { ChartOutput } from './chart.js';
import type { ParamInfo } from './params.js';
import type { ControlInfo } from './ui.js';
import type { RowTypeInfo } from './rowtype.js';

/** The end of a message channel: a worker's `self`, a `MessagePort`, or anything shaped like them. */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** How a cell's output is sent to the page: the value itself when it can be cloned, otherwise a description. */
export type Display =
  | { kind: 'none' }
  | { kind: 'value'; value: unknown }
  | { kind: 'text'; text: string }
  /** A collected result: its table and first rows; fetch more with `rows`. */
  | { kind: 'table'; table: CollectedTable; preview: Rows }
  /** Markdown text (md`…`), for the page to render. */
  | { kind: 'markdown'; text: string }
  /** A chart (chart.bar(…) and the others): its kind, options, and the rows it draws, for the page to draw. */
  | { kind: 'chart'; chart: ChartOutput };

/** A cell's state as the page sees it: its values stay in the kernel. */
export interface CellView {
  id: string;
  status: CellState['status'];
  reason: string | null;
  output: Display;
  error: CellState['error'];
  ms: number | null;
  runs: number;
  /** The controls (ui.*) the cell declared when it last ran, with their values. */
  controls: ControlInfo[];
  /** A plain SQL query cell's row type, inferred and pinned (see smaltnb/rowtype). */
  rowType: RowTypeInfo | null;
}

/** The notebook as the page needs it to draw cells, the graph and diagnostics. */
export interface NotebookView {
  cells: Cell[];
  edges: Edge[];
  order: string[];
  diagnostics: Diagnostic[];
}

/** Page to kernel. Each request has an id; the kernel answers with `done` or `failed` for that id. */
export type Request =
  | { type: 'open'; id: number; source: string; fileName?: string; params?: Record<string, string>; controls?: Record<string, Record<number, unknown>> }
  | { type: 'setControl'; id: number; cell: string; index: number; value: unknown }
  | { type: 'setParams'; id: number; values: Record<string, string | null> }
  | { type: 'update'; id: number; source: string }
  | { type: 'run'; id: number; cells: string[]; force?: boolean }
  | { type: 'runAll'; id: number; actions?: boolean }
  | { type: 'rows'; id: number; cell: string; offset: number; limit: number; name?: string };

/** Kernel to page. */
export type Reply =
  | { type: 'ready' }
  | { type: 'notebook'; notebook: NotebookView }
  | { type: 'params'; params: ParamInfo[] }
  | { type: 'state'; state: CellView }
  | { type: 'done'; id: number; result?: unknown }
  | { type: 'failed'; id: number; message: string };

export interface KernelOptions {
  /** smaltty, the TypeScript kit (`smaltty` from smaltkit/typescript), or a promise of it. */
  ts: TypeScriptKit | Promise<TypeScriptKit>;
  /** Loads what notebooks import. In a worker: `(spec) => import(spec)`. */
  importModule?: ModuleLoader;
  /** Opens the notebook's database, once: a smaltdb `Database` with smaltql and smaltdf registered. */
  database?: () => unknown | Promise<unknown>;
  /** What later cells read a collected table as: smaltdf's `table`. */
  frame?: (table: string) => object;
}

/** Serves notebooks on an endpoint: one notebook at a time, replaced by each `open`. */
export function serveKernel(endpoint: MessageEndpoint, options: KernelOptions): void {
  const post = (reply: Reply) => endpoint.postMessage(reply);
  const tsReady = Promise.resolve(options.ts);
  let database: Promise<unknown> | undefined;
  const openDatabase = () => (database ??= Promise.resolve(options.database?.()));
  let runtime: Runtime | null = null;
  let fileName: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const describe = (ts: TypeScriptKit, source: string): NotebookView => {
    const graph = buildGraph(parseNotebook(source, ts, { fileName }));
    return { cells: graph.cells, edges: graph.edges, order: graph.order, diagnostics: graph.diagnostics };
  };

  const handle = async (req: Request) => {
    const ts = await tsReady;
    switch (req.type) {
      case 'open':
        fileName = req.fileName;
        post({ type: 'notebook', notebook: describe(ts, req.source) });
        runtime = createRuntime(req.source, {
          ts, fileName, importModule: options.importModule,
          database: options.database ? await openDatabase() : undefined, frame: options.frame,
          onChange: (state) => post({ type: 'state', state: view(state) }),
          params: req.params,
          controls: req.controls,
          onParams: (params) => post({ type: 'params', params }),
        });
        for (const s of runtime.states()) post({ type: 'state', state: view(s) });
        return;
      case 'update':
        // The page gets the new cells and diagnostics at once, before anything reruns.
        post({ type: 'notebook', notebook: describe(ts, req.source) });
        return opened().update(req.source);
      case 'run':
        return opened().run(req.cells, { force: req.force });
      case 'runAll':
        return opened().runAll({ actions: req.actions });
      case 'setParams':
        return opened().setParams(req.values);
      case 'setControl':
        return opened().setControl(req.cell, req.index, req.value);
      case 'rows':
        return opened().rows(req.cell, req.offset, req.limit, req.name);
    }
  };
  const opened = (): Runtime => {
    if (!runtime) throw new Error('No notebook is open: send open first.');
    return runtime;
  };

  endpoint.addEventListener('message', (event) => {
    const req = event.data as Request;
    if (!req || typeof req !== 'object' || typeof req.id !== 'number') return;
    // Notebook changes reach the page in order; runs queue inside the runtime.
    const work = req.type === 'open' || req.type === 'update' ? (queue = queue.then(() => handle(req))) : queue.then(() => handle(req));
    work.then(
      (result) => post({ type: 'done', id: req.id, ...(result !== undefined && { result }) }),
      (err: unknown) => post({ type: 'failed', id: req.id, message: err instanceof Error ? err.message : String(err) }),
    );
  });
  void tsReady.then(() => post({ type: 'ready' }), () => {});
}

/** A cell's state for the page. */
export function view(state: CellState): CellView {
  return {
    id: state.id, status: state.status, reason: state.reason, error: state.error, ms: state.ms, runs: state.runs,
    controls: state.controls.map((c) => ({ ...c, ...(c.options && { options: [...c.options] }) })),
    rowType: state.rowType && { ...state.rowType },
    output: state.outputChart && state.runs > 0 ? { kind: 'chart', chart: state.outputChart }
      : state.outputTable ? { kind: 'table', table: tableInfo(state.outputTable), preview: state.outputTable.preview }
      : state.hasOutput && state.runs > 0 && state.output instanceof Markdown ? { kind: 'markdown', text: state.output.text }
      : state.hasOutput && state.runs > 0 ? toDisplay(state.output) : { kind: 'none' },
  };
}

function tableInfo(t: CollectedTable): CollectedTable {
  return { table: t.table, columns: t.columns, columnTypes: t.columnTypes, rowCount: t.rowCount };
}

/** A value as it can cross to the page: cloned when it can be, otherwise described. */
export function toDisplay(value: unknown): Display {
  try {
    return { kind: 'value', value: structuredClone(value) };
  } catch {
    return { kind: 'text', text: describeValue(value) };
  }
}

function describeValue(value: unknown): string {
  if (typeof value === 'function') return `[function ${value.name || '(anonymous)'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (value && typeof value === 'object') {
    const name = (value as object).constructor?.name;
    return name && name !== 'Object' ? `[${name}]` : '[object]';
  }
  return String(value);
}
