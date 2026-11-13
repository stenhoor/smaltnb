# Notebooks

::: tip Try it
[Open a notebook](/app/){target="_self"}: [the notebook page](./page) runs in your browser.
Cells run reactively with SQL and dataframes, in a worker off the page. Parts marked *planned* come later
([Status](./status)).
:::

smaltnb is a reactive notebook for [smaltdb](https://smaltdb.dev), for data work in the browser: loading and cleaning
data (ETL), analysis and exploration. TypeScript, SQL ([smaltql](https://stenhoor.github.io/smaltql/)) and dataframes
([smaltdf](https://stenhoor.github.io/smaltdf/)) are first-class.

## A notebook

A notebook is a TypeScript file named `*.nb.ts`. `cell()` starts a cell; everything up to the next `cell()` belongs to
it.

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
export const raw = sql`SELECT order_id, region, qty, price FROM orders_raw WHERE placed >= ${params.since}`;

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

`cell()`, `action()`, `sql`, `exec`, `db`, `param`, `md`, `ui` and `chart` exist today.
[examples/shop.nb.ts](../../examples/shop.nb.ts) is a notebook with SQL and smaltdf that typechecks and runs now.

## Reactive

Each cell defines top-level names and reads names other cells define. That gives the graph: when a cell changes, the
cells that read it react, according to their run mode.

| Run mode | When an input changes |
|---|---|
| `auto` (default) | The cell runs again. |
| `lazy` | The cell is marked stale and waits to be run, and so does everything after it. |
| `manual` | The cell runs only when you run it. |

A name is defined in one cell, and assigned only there. A notebook reads top to bottom: a cell can't read a name
defined further down, except a function declaration. See [the format](./format) for the exact rules.

## Parameters

`param()` declares values set from outside the notebook, with their defaults in the source:

```ts
cell('params');
export const params = param({
  mode: param.choice(['incremental', 'full'], 'incremental'),  // params.mode: 'incremental' | 'full'
  since: param.isoDate('2026-10-01'),                           // a date as YYYY-MM-DD text
  minQty: param.number(1),
  dry: param.bool(true),
  label: param.text('orders'),
});
```

- **In the page,** a params bar shows a control for each one. A change reruns what reads it, and goes into the page's
  address, so `…/app/?mode=full&minQty=5` opens the notebook with those values: a link shares them.
- **Values from outside are text,** and each is checked: a choice not in the list, a number that isn't one, a date
  that isn't `YYYY-MM-DD` is an error on the declaring cell, with the reason, until the value is changed.
- **Outside a running notebook** (a library import, a plain run) `param()` gives the defaults.
- A parameter is declared in one cell. Parameters work with guards: `when: () => params.mode === 'full'`.

## Controls

`ui.*` declares an input in a cell, drawn under its code. Its `value` is what the cell reads:

```ts
cell('bigOrders');
const region = ui.select(['all', 'north', 'south'], 'all', { label: 'Region' });
const atLeast = ui.slider(0, 2000, 1000, { step: 100, label: 'Revenue at least' });
export const bigOrders = sql`SELECT * FROM ${orders}
  WHERE revenue >= ${atLeast.value} AND ${region.value} IN ('all', region)`;
```

| Control | Value |
|---|---|
| `ui.select(options, value)` | One of the options (its type is their union), as buttons, or a menu for more than six. |
| `ui.slider(min, max, value, { step })` | A number between min and max. |
| `ui.number(value, { min, max, step })` | A number, typed in. |
| `ui.text(value)` | Text. |
| `ui.checkbox(value)` | `true` or `false`. |
| `ui.date(value)` | A date as `YYYY-MM-DD` text. |

- **A change runs the cell again** with the new value, and what reads the cell reacts as to an edit.
- **Values belong to the page,** kept per cell in the order the cell declares them, and kept across a restart. A value
  that no longer fits the control (the options changed, out of range) goes back to the default.
- **Controls or parameters?** A [parameter](#parameters) is the notebook's input from outside: in the page's address
  and a [headless run](./headless)'s arguments. A control is for exploring in the page: a headless run, or an import, uses
  its default.

## Guards

`when` makes a cell conditional on the notebook's values:

```ts
action('write clean', { when: () => params.mode === 'full' });
```

The guard is a typed function, and what it reads is part of the graph, so it is checked again when those values
change. A cell whose guard is false is skipped and shows why; the cells after it are skipped too and keep their last
results, marked stale.

## Cells that write

A cell that changes data (an `INSERT`, a `CREATE TABLE`, a smaltdf `insertInto`) is an action. Whether a cell writes is
decided by the plans it sends to the engine, whatever language they come from. An action tracks its inputs but never
reruns on its own: it runs when you click Run, or in a scheduled run. After it writes a table, the cells that read the
table go stale (*planned*: needs plans to report the tables they write). `action()` marks it in the file; an unmarked
write is held until you run it.

## SQL and dataframes

`` sql`…` `` is a query; `${}` inside it passes a value as a parameter, or another cell's result as a table. smaltdf
reads a SQL result as a frame, and SQL reads a frame's result, because both build plans for the same engine. Results
are collected once per run, in memory by default, and the page only ever holds the rows on screen. See
[the database](./runtime#the-database).

### Row types

A query's rows have a TypeScript type, `` sql<{ region: string; revenue: number }>`…` ``, so what reads them is checked:
a chart's column names, smaltdf's, your own code's. You don't write it by hand. After a SQL cell runs, **Pin types**
writes the type its columns give into the notebook (the SQL view stays as it is; **TS** shows the type). When a later
run no longer matches what is pinned (a column added, renamed, or of another type), the cell says **types out of date**,
with what changed, and **Update types** pins the new one.

- Columns map to `number` (integers and reals), `string`, `boolean`, `Uint8Array`, or `unknown` where the engine
  doesn't know. Whether a column can be NULL isn't reported yet: add `| null` by hand where it can; the check keeps it.
- A named type (`sql<Order>`) is yours: it isn't checked against the run.
- It's offered on plain SQL cells, which the page writes back. *Planned:* the same for queries in TypeScript cells and
  for smaltdf frames.

## Charts

A `chart.*` call as a cell's last expression shows a chart of a result as the cell's output:

```ts
cell('revenueChart');
chart.bar(byRegion, { x: 'region', y: 'revenue', labels: true });
```

- **Kinds:** `bar` (horizontal), `column`, `line`, `area`, `pie`, `donut` and `scatter`.
- **Columns:** `x` is the categories (for `scatter`, a number), and `y` a column of values, or several, one series
  each. `series` splits one measure into series by a column's values; `size` sizes a scatter's points.
- **Options:** `stack` (`'none'`, `'stacked'`, `'percent'`), `labels`, `smooth`, `markers`, `title`, `height`.
- **Data:** a query, a smaltdf frame, another cell's result, or an array of row objects. With a typed query
  (`` sql<Row>`…` ``) or typed rows, the column names are checked as you type. A name the data doesn't have is an
  error on the cell, with the columns it has.
- **Large results:** a chart reads at most 5,000 rows, and says when there were more.

Charts come from `smaltkit/charts`, shared with the other smalt apps.

## Notebooks as libraries

`export` marks what other notebooks may import. Importing a notebook runs only the cells the imported names need, never
its actions:

```ts
import { cell, sql } from 'smaltnb';
import { orders } from './orders.nb.ts';

cell('byRegion', { lang: 'sql' });
export const byRegion = sql`SELECT region, sum(revenue) AS revenue FROM ${orders} GROUP BY region`;
```

- **Only what's needed runs.** The imported notebook's cells that `orders` reads, directly or through other cells, run
  in order ([`exportClosure`](./format#the-graph)). Its other cells and its actions don't, and a write in a cell that
  does run is held, so an import never changes data.
- **Results cross.** A collected result (a query, a frame) is imported as itself: SQL reads it with `${}`, smaltdf
  chains on it. Each imported notebook keeps its tables apart from the importer's, so cells may share names.
- **Paths are relative,** to the importing notebook's folder: `./orders.nb.ts`, `../lib/clean.nb.ts`. An imported
  notebook can import others; notebooks that import each other are an error, naming the chain.
- **Parameters** of an imported notebook take their defaults.
- **Where it works:** [`smaltnb run`](./headless) reads imports from the notebook's folder, and so does the runtime given
  `readNotebook`. In the page, notebooks have no folder yet: an import there says so (*planned*, with a local repository folder).
- `tsc` checks an import as written (with `allowImportingTsExtensions`): [examples/report.nb.ts](../../examples/report.nb.ts)
  imports [examples/orders.nb.ts](../../examples/orders.nb.ts).

### Built notebooks: the typed factory

To set an imported notebook's parameters, or to use a notebook from an app, build it. `smaltnb build` writes each
notebook as a library: a `.nb.js` whose default export is the notebook's **factory**, and a `.nb.d.ts` that types it
from the notebook's own source.

```sh
smaltnb build notebooks/orders.nb.ts notebooks/report.nb.ts --out dist
```

```ts
import orders from './dist/orders.nb.js';

const { orders: big } = await orders.with({ minQty: 3 }).get('orders');
```

- **`with(params)`** opens the notebook with those parameter values; the rest take their defaults. They're typed when
  the notebook exports its parameters as `params` (`export const params = param({ … })`), so `{ minQty: 'three' }` or a
  parameter it doesn't have is a type error. The same values give the same instance.
- **`get(...names)`** runs only the cells those exports need, once, and gives their values; never an action. `get` on
  the factory itself uses the defaults.
- **The database:** in a notebook that imports a factory, it runs on that notebook's database. In an app, give one:
  `orders.with(params, { database, frame: table })`, or `orders.in({ database, frame: table })` for every call.
- **What it needs:** the built `.js` holds the notebook's source and reads it with smaltty when it runs, so it needs
  smaltnb and smaltkit installed beside it, not TypeScript. A notebook that imports another by name is built in the
  same command (`build` says so if it isn't), and the built one loads the other's built module.
- **Folders:** under `--out` (default `dist`), the notebooks keep their folders, from their common folder. Keep the
  output apart from the sources: TypeScript resolves `./orders.nb.js` to `./orders.nb.ts` when both are in one folder.

*Planned:* imports from other repositories (`gh:owner/repo@commit/path.nb.ts`, with a lock file), and compiled cells
in the built `.js`, so it needn't read TypeScript when it runs.
