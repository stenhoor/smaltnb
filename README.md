# smaltnb

**Small. Alternative. Notebooks.**

Reactive notebooks for [smaltdb](https://github.com/stenhoor/smaltdb). A notebook is a TypeScript file: cells are
top-level code, the graph comes from the names they define and read, and `export` makes a notebook a library other
notebooks import. TypeScript, SQL ([smaltql](https://github.com/stenhoor/smaltql)) and dataframes
([smaltdf](https://github.com/stenhoor/smaltdf)) are first-class.

Inspired by marimo, Jupyter and JupyterLab.

> **Status: early development.** The notebook format, its graph and the runtime are in: notebooks in plain TypeScript
> run, with run modes and guards. No notebook page, database or SQL yet.
> See the [site](https://stenhoor.github.io/smaltnb/) and [docs/DESIGN.md](docs/DESIGN.md).

```ts
import { cell, sql } from 'smaltnb';
import { col } from '@smaltdb/df';

cell('raw', { lang: 'sql' });
export const raw = sql`SELECT region, qty, price FROM orders`;

cell('clean', { lang: 'df' });
export const clean = raw.filter(col('qty').gt(0));
```

## Modules

| Import | What it does |
| --- | --- |
| `smaltnb` | `cell()` and `action()`, the statements a notebook is written with, plus everything below. |
| `smaltnb/format` | `parseNotebook(source, ts)`: splits a `.nb.ts` file into cells, reads their options, and finds the names each defines, reads and exports, with diagnostics (a cell reading a name defined further down, a name assigned outside its cell, bad options, …). |
| `smaltnb/graph` | `buildGraph(notebook)`: edges, run order, `upstream` / `downstream`, `exportClosure` (what importing an export needs) and `propagate` (what reruns and what goes stale after a change). |
| `smaltnb/runtime` | `createRuntime(source, { ts, importModule })`: runs cells as async functions, keeps each cell's state (`ok`, `stale`, `skipped`, `error`, …) and output, and reacts to `update(source)`, `run(ids)` and `runAll()` by the notebook's rules. |

The TypeScript compiler is passed in (`ts`), not bundled: a page loads it at run time, Node imports `typescript`.

## Develop

```bash
npm install          # builds dist/ (prepare)
```

```bash
npm run typecheck    # src/, test/, and examples/*.nb.ts, which must typecheck as written
```

```bash
npm test             # builds, then node --test against the built package
```

```bash
npm run docs:dev     # the site, with live reload
```

## License

MIT
