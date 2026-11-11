<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-on-dark.svg">
    <img alt="smaltnb" src="docs/brand/lockup.svg" width="320">
  </picture>
</h1>

<a href="https://smaltworks.dev/stability"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/work-in-progress-on-dark.svg"><img alt="Work in progress. Come build with us." src="docs/brand/work-in-progress.svg" height="56"></picture></a>

**Small. Alternative. Notebooks.** Reactive notebooks for smaltdb.

[Documentation](https://stenhoor.github.io/smaltnb/) · [smaltworks.dev](https://smaltworks.dev)

Notebooks are reactive, and run on [smaltdb](https://github.com/stenhoor/smaltdb). A notebook is a TypeScript file: cells are
top-level code, the graph comes from the names they define and read, and `export` makes a notebook a library other
notebooks import. TypeScript, SQL ([smaltql](https://github.com/stenhoor/smaltql)) and dataframes
([smaltdf](https://github.com/stenhoor/smaltdf)) are first-class.

Inspired by marimo, Jupyter and JupyterLab.

> **Status: early development.** [Open a notebook](https://stenhoor.github.io/smaltnb/app/): the notebook page runs in
> your browser, with SQL and smaltdf cells, text, run modes, guards, parameters and held writes. See the
> [site](https://stenhoor.github.io/smaltnb/) and [docs/DESIGN.md](docs/DESIGN.md).

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
| `smaltnb` | What notebooks import: `cell()`, `action()`, `` sql`…` ``, `` exec`…` `` and `db`; plus everything below. |
| `smaltnb/format` | `parseNotebook(source, ts)`: splits a `.nb.ts` file into cells, reads their options, and finds the names each defines, reads and exports, with diagnostics (a cell reading a name defined further down, a name assigned outside its cell, bad options, …). |
| `smaltnb/graph` | `buildGraph(notebook)`: edges, run order, `upstream` / `downstream`, `exportClosure` (what importing an export needs) and `propagate` (what reruns and what goes stale after a change). |
| `smaltnb/runtime` | `createRuntime(source, { ts, importModule })`: runs cells as async functions, keeps each cell's state (`ok`, `stale`, `skipped`, `error`, …) and output, and reacts to `update(source)`, `run(ids)` and `runAll()` by the notebook's rules. |
| `smaltnb/kernel` | `serveKernel(self, { ts, importModule })`: the runtime in a Web Worker, over messages. |
| `smaltnb/client` | `KernelClient`: the page's side. `open`, `update`, `run`, `runAll`, and `restart()` to stop a run that never finishes. |

TypeScript is read, bound and stripped by [smaltty](https://stenhoor.github.io/smaltty/), our own TypeScript kit, passed
in as `ts`: `import { smaltty } from 'smaltkit/typescript'`, in a page and in Node alike. Types are removed, never
compiled (TypeScript's `erasableSyntaxOnly`): an enum, a namespace with values, a parameter property or `<T>x` in a cell
is an error on that cell, which says what to write instead. In the page, smaltty's checker (`smaltkit/typecheck`, in a
worker) marks TypeScript's errors in calls into smaltnb and smaltdf as warnings while you type; the notebook still runs.

## Develop

```bash
npm install          # builds dist/ (prepare)
```

```bash
npm run deps         # smaltdb, smaltql and smaltdf, pinned in packed.json until they are on npm (again after each npm install)
```

```bash
npm run typecheck    # src/, test/, and examples/*.nb.ts, which must typecheck as written
```

```bash
npm test             # builds, then node --test against the built package
```

```bash
npm run app          # the notebook page, built and served at http://localhost:8090/
```

```bash
npm run e2e          # the page in headless Chromium (needs Playwright)
```

```bash
npm run docs:dev     # the site, with live reload
```

## License

<a href="https://smaltworks.dev"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/a-smaltworks-project-on-dark.svg"><img alt="A smaltworks project" src="docs/brand/a-smaltworks-project.svg" height="28"></picture></a>

MIT License.
