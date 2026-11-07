# Notebooks

::: warning In development
The format, its graph, [the runtime](./runtime), [the kernel](./runtime#the-kernel) and [the database](./runtime#the-database)
are in ([Status](./status)): notebooks run, with SQL and dataframes, run modes and guards, in a worker off the page. There's no notebook page, database or SQL yet. Parts marked *planned* come later.
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

`cell()`, `action()`, `sql`, `exec` and `db` exist today; `md`, `param`, `ui` and `chart` are *planned*.
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

## Notebooks as libraries

`export` marks what other notebooks may import. Importing a notebook runs only the cells the imported names need, never
its actions:

```ts
import { clean } from './regional.nb.ts';
```

*Planned.* What an import needs is computed today: [`exportClosure`](./format#the-graph).
