// A notebook as a compiled library (DESIGN.md decision 14). `smaltnb build` writes, for each notebook, a `.nb.js` whose
// default export is the notebook's factory and a `.nb.d.ts` that types it from the notebook's own source:
//
//   import regional from './dist/regional.nb.js';
//   const { clean } = await regional.with({ mode: 'full' }).get('clean');
//
// `with(params)` opens the notebook with those parameter values; `get(...names)` runs only the cells those exports need
// (never an action) and gives their values. Inside a notebook, the factory uses the importing notebook's database;
// elsewhere, give one with `with(params, { database })`. The parameters are typed when the notebook exports them as
// `params` (`export const params = param({ … })`).
//
// Nothing here uses Node: the built module passes in smaltty and its own module loader.

import { createRuntime, type ModuleLoader, type Runtime } from './runtime.js';
import type { TypeScriptKit } from './format.js';

const FACTORY = Symbol.for('smaltnb.factory');

/** Where a factory's notebook runs: its database, and what reads a collected table (smaltdf's `table`). */
export interface NotebookContext {
  database?: unknown;
  frame?: (table: string) => object;
}

/** A notebook module's exports, without the default (the factory). */
export type NotebookExports<M> = Omit<M, 'default'>;

/** The parameter values a notebook takes: typed from its exported `params`, else any. */
export type NotebookParams<M> = M extends { params: infer P extends object }
  ? { readonly [K in keyof P]?: P[K] }
  : Readonly<Record<string, string | number | boolean>>;

/** A notebook opened with parameter values. */
export interface NotebookInstance<E> {
  /** Runs what these exports need (once) and gives their values. */
  get<K extends keyof E & string>(...names: K[]): Promise<Pick<E, K>>;
  /** The runtime the notebook runs in, for its cells' states. */
  readonly runtime: Runtime;
}

/** A built notebook's default export. */
export interface NotebookFactory<M> {
  /** The notebook's file name, as it was built. */
  readonly fileName: string;
  /** The notebook's source. */
  readonly source: string;
  /** The notebook with these parameter values (the rest take their defaults), in `context` or the default one. */
  with(params?: NotebookParams<M>, context?: NotebookContext): NotebookInstance<NotebookExports<M>>;
  /** The notebook with its default parameters. */
  get<K extends keyof NotebookExports<M> & string>(...names: K[]): Promise<Pick<NotebookExports<M>, K>>;
  /** The same factory, running in this context unless `with` is given another. */
  in(context: NotebookContext): NotebookFactory<M>;
}

export interface NotebookDefinition {
  fileName: string;
  source: string;
  /** smaltty, the TypeScript kit. */
  ts: TypeScriptKit;
  /** Loads what the notebook imports, from the built module's folder: `(spec) => import(spec)` written there. */
  importModule: ModuleLoader;
  /** The built modules of the notebooks it imports by name (`./orders.nb.ts`), by their path as built (`fileName`'s). */
  notebooks?: Record<string, () => Promise<{ default: NotebookFactory<unknown> }>>;
}

/** Whether a value is a built notebook's factory. */
export function isNotebookFactory(value: unknown): value is NotebookFactory<unknown> {
  return !!value && typeof value === 'object' && FACTORY in value;
}

/** A short, stable name for a text. */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Makes a built notebook's factory. `smaltnb build` writes the call; it isn't meant to be written by hand. */
export function notebookFactory<M = Record<string, unknown>>(def: NotebookDefinition, context: NotebookContext = {}): NotebookFactory<M> {
  const instances = new Map<string, NotebookInstance<NotebookExports<M>>>();
  const factory: NotebookFactory<M> & { [FACTORY]: true } = {
    [FACTORY]: true,
    fileName: def.fileName,
    source: def.source,
    with(params = {} as NotebookParams<M>, ctx = context) {
      const text = Object.fromEntries(Object.entries(params as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
      const key = JSON.stringify(Object.entries(text).sort()) + (ctx === context ? '' : '#own');
      const cached = ctx === context ? instances.get(key) : undefined;
      if (cached) return cached;
      const runtime = createRuntime(def.source, {
        ts: def.ts, fileName: def.fileName, importModule: def.importModule, params: text,
        database: ctx.database, frame: ctx.frame,
        tablePrefix: `nb_${hash(def.fileName + key)}_`,
        readNotebook: async (path) => {
          const load = def.notebooks?.[path];
          if (!load) throw new Error(`${def.fileName} imports ${path}, which wasn't built with it: build both with smaltnb build.`);
          return (await load()).default.source;
        },
      });
      const instance: NotebookInstance<NotebookExports<M>> = {
        runtime,
        // A parameter value that doesn't fit fails the cell that declares it, and evaluate says so.
        get: async (...names) => (await runtime.evaluate(names)) as never,
      };
      if (ctx === context) instances.set(key, instance);
      return instance;
    },
    get: (...names) => factory.with().get(...names),
    in: (ctx) => notebookFactory<M>(def, ctx),
  };
  return factory;
}
