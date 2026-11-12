// The page's side of the kernel (./kernel.js): sends a notebook and edits to a worker, keeps the cell states it reports,
// and replaces the worker when a run has to be stopped. Imports only types from the kernel, so a page loads neither
// the runtime nor the TypeScript compiler.

import type { CellView, NotebookView, Reply, Request } from './kernel.js';
import type { Rows } from './database.js';
import type { ParamInfo } from './params.js';

/** What the client needs of a worker: a browser `Worker`, or an adapter around another kind. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

export interface KernelClientOptions {
  /** Called with each cell's state when it changes. */
  onState?: (state: CellView) => void;
  /** Called with the notebook's cells, graph and diagnostics whenever the source changes. */
  onNotebook?: (notebook: NotebookView) => void;
  /** Called with the notebook's parameters whenever they change. */
  onParams?: (params: ParamInfo[]) => void;
}

type Body<T> = T extends { id: number } ? Omit<T, 'id'> : never;

export class KernelClient {
  #create: () => WorkerLike;
  #options: KernelClientOptions;
  #worker!: WorkerLike;
  #nextId = 1;
  #pending = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  #states = new Map<string, CellView>();
  #notebook: NotebookView | null = null;
  #source: string | null = null;
  #fileName: string | undefined;
  #params: ParamInfo[] = [];
  #paramValues: Record<string, string> = {};
  #controlValues: Record<string, Record<number, unknown>> = {};

  constructor(createWorker: () => WorkerLike, options: KernelClientOptions = {}) {
    this.#create = createWorker;
    this.#options = options;
    this.#start();
  }

  /** The notebook as last reported: cells, edges, run order and diagnostics. */
  get notebook(): NotebookView | null { return this.#notebook; }

  /** The state of every cell, in file order. */
  states(): CellView[] {
    return (this.#notebook?.cells ?? []).map((c) => this.#states.get(c.id)).filter((s): s is CellView => !!s);
  }

  state(id: string): CellView | undefined {
    return this.#states.get(id);
  }

  /** The notebook's parameters, as last reported. */
  get params(): ParamInfo[] {
    return this.#params;
  }

  /** Opens a notebook, replacing the one open, with parameter values as text. Nothing runs until `runAll` or `run`. */
  open(source: string, fileName?: string, params: Record<string, string> = {}): Promise<void> {
    this.#source = source;
    this.#fileName = fileName;
    this.#paramValues = { ...params };
    this.#controlValues = {};
    this.#states.clear();
    this.#params = [];
    return this.#send({ type: 'open', source, params, ...(fileName !== undefined && { fileName }) });
  }

  /** Sets parameter values, as text; null goes back to the default. The cells that read them react. */
  setParams(values: Record<string, string | null>): Promise<void> {
    for (const [k, v] of Object.entries(values)) {
      if (v === null) delete this.#paramValues[k];
      else this.#paramValues[k] = v;
    }
    return this.#send({ type: 'setParams', values });
  }

  /** Sets a control's value (null goes back to its default): its cell runs again, and what reads it reacts. */
  setControl(cell: string, index: number, value: unknown): Promise<void> {
    const values = (this.#controlValues[cell] ??= {});
    if (value === null) delete values[index];
    else values[index] = value;
    return this.#send({ type: 'setControl', cell, index, value });
  }

  /** Sends an edit: changed cells and what follows react. */
  update(source: string): Promise<void> {
    this.#source = source;
    return this.#send({ type: 'update', source });
  }

  /** Runs cells on request (the Run button); `force` ignores their guards. */
  run(cells: string[], options: { force?: boolean } = {}): Promise<void> {
    return this.#send({ type: 'run', cells, ...(options.force && { force: true }) });
  }

  /** Runs every cell in order; actions only with `{ actions: true }`. */
  runAll(options: { actions?: boolean } = {}): Promise<void> {
    return this.#send({ type: 'runAll', ...(options.actions && { actions: true }) });
  }

  /** A window of a cell's collected output (or of one of its collected names), for a grid that scrolls. */
  async rows(cell: string, offset: number, limit: number, name?: string): Promise<Rows> {
    return (await this.#send({ type: 'rows', cell, offset, limit, ...(name !== undefined && { name }) })) as Rows;
  }

  /**
   * Stops whatever is running by replacing the worker, then opens the notebook again in the new one. Every cell's
   * result is lost and its state goes back to idle; requests that were waiting fail.
   */
  async restart(): Promise<void> {
    this.#worker.terminate();
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of waiting) p.reject(new Error('The kernel was restarted.'));
    this.#start();
    for (const s of this.#states.values()) {
      this.#setState({ ...s, status: 'idle', reason: 'the kernel was restarted', output: { kind: 'none' }, error: null });
    }
    if (this.#source !== null) {
      await this.#send({ type: 'open', source: this.#source, params: this.#paramValues, controls: this.#controlValues, ...(this.#fileName !== undefined && { fileName: this.#fileName }) });
      // The new kernel reports its cells as idle with no reason; keep the reason until they run again.
      for (const s of this.#states.values()) if (s.status === 'idle') this.#setState({ ...s, reason: 'the kernel was restarted' });
    }
  }

  /** Stops the worker. The client can't be used afterwards. */
  close(): void {
    this.#worker.terminate();
    for (const p of this.#pending.values()) p.reject(new Error('The kernel was closed.'));
    this.#pending.clear();
  }

  #start() {
    const worker = this.#create();
    this.#worker = worker;
    worker.addEventListener('message', (event) => {
      if (worker !== this.#worker) return; // a message from a replaced worker
      this.#receive(event.data as Reply);
    });
  }

  #send(body: Body<Request>): Promise<any> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...body, id } as Request);
    });
  }

  #setState(state: CellView) {
    this.#states.set(state.id, state);
    this.#options.onState?.(state);
  }

  #receive(reply: Reply) {
    switch (reply.type) {
      case 'notebook': {
        this.#notebook = reply.notebook;
        const ids = new Set(reply.notebook.cells.map((c) => c.id));
        for (const id of [...this.#states.keys()]) if (!ids.has(id)) this.#states.delete(id);
        // Controls of cells that are gone are dropped with them, as in the kernel.
        for (const id of Object.keys(this.#controlValues)) if (!ids.has(id)) delete this.#controlValues[id];
        this.#options.onNotebook?.(reply.notebook);
        return;
      }
      case 'state':
        this.#setState(reply.state);
        return;
      case 'params':
        this.#params = reply.params;
        this.#options.onParams?.(reply.params);
        return;
      case 'done':
      case 'failed': {
        const p = this.#pending.get(reply.id);
        if (!p) return;
        this.#pending.delete(reply.id);
        if (reply.type === 'done') p.resolve(reply.result);
        else p.reject(new Error(reply.message));
        return;
      }
      case 'ready':
        return;
    }
  }
}
