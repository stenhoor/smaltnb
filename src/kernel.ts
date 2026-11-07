// The kernel: the runtime (./runtime.js) served over messages, to run in a Web Worker. Cell code runs there, off the
// page, so a cell that never finishes can be stopped by replacing the worker (see ./client.js), and the database,
// which has its own worker, is not touched.
//
// In the app's worker file:
//
//   import { serveKernel, loadTypeScript } from 'smaltnb/kernel';
//   serveKernel(self, { ts: loadTypeScript(), importModule: (spec) => import(spec) });

import { parseNotebook, type Cell, type Diagnostic, type TypeScript } from './format.js';
import { buildGraph, type Edge } from './graph.js';
import { createRuntime, type CellState, type ModuleLoader, type Runtime } from './runtime.js';

/** Where the TypeScript compiler is loaded from by default: the version smaltnb is built and tested with. */
export const TYPESCRIPT_URL = 'https://cdn.jsdelivr.net/npm/typescript@5.9.3/lib/typescript.js';

/** The end of a message channel: a worker's `self`, a `MessagePort`, or anything shaped like them. */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** How a cell's output is sent to the page: the value itself when it can be cloned, otherwise a description. */
export type Display =
  | { kind: 'none' }
  | { kind: 'value'; value: unknown }
  | { kind: 'text'; text: string };

/** A cell's state as the page sees it: its values stay in the kernel. */
export interface CellView {
  id: string;
  status: CellState['status'];
  reason: string | null;
  output: Display;
  error: CellState['error'];
  ms: number | null;
  runs: number;
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
  | { type: 'open'; id: number; source: string; fileName?: string }
  | { type: 'update'; id: number; source: string }
  | { type: 'run'; id: number; cells: string[]; force?: boolean }
  | { type: 'runAll'; id: number; actions?: boolean };

/** Kernel to page. */
export type Reply =
  | { type: 'ready' }
  | { type: 'notebook'; notebook: NotebookView }
  | { type: 'state'; state: CellView }
  | { type: 'done'; id: number }
  | { type: 'failed'; id: number; message: string };

export interface KernelOptions {
  /** The TypeScript compiler, or a promise of it (see `loadTypeScript`). */
  ts: TypeScript | Promise<TypeScript>;
  /** Loads what notebooks import. In a worker: `(spec) => import(spec)`. */
  importModule?: ModuleLoader;
}

/** Serves notebooks on an endpoint: one notebook at a time, replaced by each `open`. */
export function serveKernel(endpoint: MessageEndpoint, options: KernelOptions): void {
  const post = (reply: Reply) => endpoint.postMessage(reply);
  const tsReady = Promise.resolve(options.ts);
  let runtime: Runtime | null = null;
  let fileName: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const describe = (ts: TypeScript, source: string): NotebookView => {
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
          onChange: (state) => post({ type: 'state', state: view(state) }),
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
      () => post({ type: 'done', id: req.id }),
      (err: unknown) => post({ type: 'failed', id: req.id, message: err instanceof Error ? err.message : String(err) }),
    );
  });
  void tsReady.then(() => post({ type: 'ready' }), () => {});
}

/** A cell's state for the page. */
export function view(state: CellState): CellView {
  return {
    id: state.id, status: state.status, reason: state.reason, error: state.error, ms: state.ms, runs: state.runs,
    output: state.hasOutput && state.runs > 0 ? toDisplay(state.output) : { kind: 'none' },
  };
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

/**
 * Evaluates the text of TypeScript's `lib/typescript.js` and returns the compiler. The file declares `var ts` and only
 * writes `module.exports` when `module` exists, so it can be evaluated in a function scope, in a module worker, with
 * no bundler.
 */
export function evaluateTypeScript(text: string): TypeScript {
  const ts = new Function(`${text}\nreturn ts;`)() as TypeScript;
  if (!ts || typeof ts.createSourceFile !== 'function') throw new Error('This file is not the TypeScript compiler (lib/typescript.js).');
  return ts;
}

/** Fetches and evaluates the TypeScript compiler: from jsDelivr by default, or the app's own copy. */
export async function loadTypeScript(url: string | URL = TYPESCRIPT_URL): Promise<TypeScript> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the TypeScript compiler from ${url}: HTTP ${res.status}.`);
  return evaluateTypeScript(await res.text());
}
