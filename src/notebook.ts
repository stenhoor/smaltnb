// The statements a notebook is written with. `cell(name, options?)` starts a reactive cell; `action(name, options?)`
// starts a cell that writes. At run time the notebook runtime reads these from the source (see ./format.js), so the
// functions themselves do nothing: they exist so a notebook is valid TypeScript, with typed, checked options.

/** The language a cell is shown and edited in. A `df` cell is TypeScript; the editor treats it as dataframe code. */
export type CellLang = 'ts' | 'sql' | 'df' | 'md';

/**
 * How a cell reacts when its inputs change: `auto` reruns it, `lazy` marks it stale until it is run, `manual` runs
 * it only on request.
 */
export type RunMode = 'auto' | 'lazy' | 'manual';

/** Where a cell's collected result is kept: in memory (default), or in the notebook's scratch database in OPFS. */
export type ResultStore = 'memory' | 'opfs';

/** A guard: the cell runs only while it returns true. Its reads are graph edges, so it re-evaluates when they change. */
export type Guard = () => boolean;

export interface CellOptions {
  lang?: CellLang;
  run?: RunMode;
  when?: Guard;
  store?: ResultStore;
  /** Bind the result as a view, so the engine plans across cells, instead of collecting it. */
  live?: boolean;
  /** Hide the cell's code in the notebook view. */
  hide?: boolean;
}

/** Options of a cell that writes. It never reruns on its own, so it has no run mode or result store. */
export interface ActionOptions {
  lang?: CellLang;
  when?: Guard;
  hide?: boolean;
}

/** Starts a reactive cell. Everything up to the next `cell()` or `action()` belongs to it. */
export function cell(name: string, options?: CellOptions): void {
  void name;
  void options;
}

/** Starts a cell that writes: it tracks its inputs but runs only from its Run button or a headless run. */
export function action(name: string, options?: ActionOptions): void {
  void name;
  void options;
}
