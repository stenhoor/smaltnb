# smaltnb design

Status: draft, from the initial interview with the owner (2026-11-07). Side effects are to be revisited once the
prototype runs.

smaltnb is a reactive TypeScript notebook for [smaltdb](https://github.com/stenhoor/smaltdb), for browser-based data
work: ETL, analysis and exploration. TypeScript, SQL ([smaltql](https://github.com/stenhoor/smaltql)) and dataframes
([smaltdf](https://github.com/stenhoor/smaltdf)) are first-class. Inspired by marimo, Jupyter and JupyterLab; it does
not aim to be a port of any of them.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Positioning | "Reactive notebooks for smaltdb." (owner, 2026-11-07: one wording everywhere; not "in TypeScript", since SQL cells aren't TypeScript). Credit once: "Inspired by marimo, Jupyter and JupyterLab." |
| 2 | File format | A notebook is a `.nb.ts` file, a valid TypeScript module that `tsc` checks as written. It is the only source format. Markdown is an export (`smaltnb export --md`), not a second source. |
| 3 | Cells | `cell(name, options?)` statements split ordinary top-level code into cells. Code before the first cell is the setup cell: imports only. Options are typed: `lang`, `run`, `when`, `store`, `live`, `hide`. |
| 4 | Graph | Edges come from the top-level names each cell defines and reads, found with the TypeScript compiler. A name is defined in one cell (TypeScript enforces this) and assigned only in that cell. The file reads top to bottom: a cell may not read a name defined further down, except a function declaration. |
| 5 | Run modes | `auto` reruns dependents, `lazy` marks them stale, `manual` runs only on request. |
| 6 | Guards | `when: () => boolean`, evaluated before the cell runs. Its reads are graph edges. A false guard skips the cell and its dependents, which keep their last results, marked stale. |
| 7 | Side effects | Defined by plan kind, not by language: any plan that is not read-only is a write, checked in one place, the notebook's database handle. Frame transformations are not writes. The notebook's own collected results are not user writes. |
| 8 | Writing cells | Inferred from their plans; the editor offers a quick fix that writes `action(name, options?)` into the file. An unmarked write is held: the cell warns and waits for its Run button. A writing cell tracks its inputs but never reruns on its own. After a write, cells that read the written table go stale. `TEMP` tables and views are writes. A transaction opens and closes within one cell. |
| 9 | Writes outside the database | Writing to a table defined over an external source is a plan, so rule 7 covers it. Other direct writes (saving files, committing output files, uploads from TypeScript) wait for an external file-writer plugin: no notebook write APIs until then. A Download button on a result grid is part of the app and is in v1. |
| 10 | SQL | `` sql`…` `` is a query and returns a relation; `` exec`…` `` is a statement. Inside either, a frame or result becomes a relation reference, a scalar a bound parameter, `sql.id(name)` an identifier. Notebook results are referenced only through `${}`; bare names are always database tables. |
| 11 | SQL and smaltdf | Both build plans for smaltdb's shared plan layer; neither generates the other. A SQL result is collected and smaltdf reads it with `table()`, with column types from the engine. The editor pins TypeScript row types in the source (``sql<Order>`…` ``) and warns when a run no longer matches. Typed plan composition later, for live cells. |
| 12 | Results | A cell's tabular result is collected once per run and dependents read it. In memory (`TEMP`) by default; `store: 'opfs'` keeps it in a per-notebook scratch database in OPFS, kept across reloads. `live: true` binds a view instead, so the engine plans across cells. |
| 13 | Large results | The page holds the row count and the visible window only; the grid fetches more from the engine as you scroll. No silent `LIMIT`. Charts warn above a row limit. Grid downloads export the full result in the engine. |
| 14 | Exports | `export` marks a notebook's public API. Importing a notebook evaluates only the imported exports and the cells they need; actions never run on import, and an export may not depend on an action. Each notebook has a typed default export, `nb.with(params)`. `smaltnb build` emits `.js` and `.d.ts`. |
| 15 | Imports | Relative paths for notebooks in the same repo; npm packages through an import map; notebooks in other repos as `gh:owner/repo@commit/path.nb.ts`, with a lock file. |
| 16 | Git | The repo lives in OPFS as real git (isomorphic-git) and syncs with GitHub through its REST Git Data API. Other remotes later, through a proxy. Outputs are never stored with the notebook. |
| 17 | Collaboration | Git only. |
| 18 | Where it runs | The browser first. Node and GitHub Actions later, without designing them out: cell code gets no DOM, and the database, file store and git sit behind interfaces. |
| 19 | Credentials | Secrets stay secret. A notebook declares what it needs, never a value (`credential(name, { kind, endpoint })`); SQL connections refer to it by name. The app registers values with the engine; cell code never sees them. Browser v1: session memory and autofill-friendly forms; later a passkey-unlocked vault and provider sign-in. Node and Actions: environment variables, cloud SDK credential lookup, OIDC. |
| 20 | Shared UI | Charts, tables and editors, and as much other UI as possible, are shared by smaltui, smaltbi and smaltnb in smaltkit. smaltnb keeps only what is notebook-specific: cell chrome, the graph view, run state. |
| 21 | Editor | smaltui's dependency-free editor, moved to `smaltkit/editor` and extended to TypeScript. The TypeScript compiler is loaded at run time, as `smaltkit/engine` loads smaltdb. |
| 22 | Charts and tables | `smaltkit/chart`, moved from smaltbi's `src/visuals/`. Two table components for now: `smaltkit/grid` (smaltui's grid) for exploring rows, smaltbi's table and matrix as chart types. |
| 23 | smaltts | Decided later. Another plan-layer language can join without a format change. |

## A notebook

```ts
import { cell, action, md, sql, param, ui, chart, db } from 'smaltnb';
import { col, deleteFrom } from '@smaltdb/df';

cell('intro');
md`# Regional revenue`;

cell('params');
export const params = param({
  mode: param.choice(['incremental', 'full'], 'incremental'),
  since: param.isoDate('2026-10-01'),
});

cell('raw', { lang: 'sql' });
export const raw = sql<Order>`SELECT order_id, region, qty, price FROM orders_raw WHERE placed >= ${params.since}`;

cell('clean', { lang: 'df', run: 'lazy' });
export const clean = raw.filter(col('qty').gt(0)).withColumns(col('qty').mul(col('price')).alias('revenue'));

cell('byRegion', { lang: 'sql' });
const region = ui.select(['all', 'north', 'south', 'east', 'west'], 'all');
export const byRegion = sql`SELECT region, sum(revenue) AS revenue FROM ${clean}
  WHERE ${region.value} IN ('all', region) GROUP BY region`;
chart.bar(byRegion, { x: 'region', y: 'revenue' });

action('write clean', { when: () => params.mode === 'full' });
await deleteFrom('orders_clean').run(db);
await clean.insertInto(db, 'orders_clean');
```

## Runtime

Three threads: the page (editor, grid, charts, controls), a kernel worker that runs cell code, and the smaltdb worker,
which registers smaltql and smaltdf. Cells are transpiled and run as async functions that receive their inputs and
return their definitions. Results cross as columnar typed arrays. A runaway cell is stopped by restarting the kernel,
without losing the database.

## Order of work

Each step is one PR.

0. **Format and graph.** The `.nb.ts` parser, graph extraction, lint rules, tests. No UI, no engine.
1. **Run.** Kernel worker, `sql` / `exec` / `md` / `param`, run modes, guards, plan-kind checks and held writes, table
   edges, collected results, grid output.
2. **Git.** isomorphic-git in OPFS, GitHub sync, per-cell diff, commit.
3. **Libraries.** Notebook imports, export closure, typed factory, `smaltnb build`, lock file.
4. **Types and UI.** Schema pinning, `ui.*` controls, charts, the OPFS result store.
5. **Headless.** `smaltnb run` in Node and GitHub Actions, `expect` cells.

## Needed from other repositories

| Repository | Needed |
|---|---|
| smaltkit | `editor`, `grid` (from smaltui), `chart`, `controls` (from smaltbi), `git` (new), the environment manifest. |
| smaltdb | Which tables a statement reads and writes (for edges through tables and staleness after a write). In the worker client, a prepared statement's `readonly` and `kind`, as the in-process engine already gives them (plan data carries its kind, so plans are checked today). A change counter like SQLite's `PRAGMA data_version`. Later: writable external tables and an external file-writer plugin. |
| smaltql | From a parse, without running: statement kind, tables read and written, result columns and types. |
| smaltdf | A plan's kind and the tables it touches. Later: a frame over another language's plan with its types, and a typed `Frame<S>`. |

smaltql and smaltdf are still changing. smaltnb reaches them only through the engine's plan layer and language
registry, so it follows their changes rather than waiting for them.
