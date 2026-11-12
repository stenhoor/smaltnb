# The runtime

`smaltnb/runtime` runs a notebook. It is the core the [kernel](#the-kernel) serves to the page and, later, headless
runs use. Given a database, it runs SQL and smaltdf cells ([below](#the-database)). The notebook page comes next in
[milestone 1](./status).

```ts
import { smaltty } from 'smaltkit/typescript';
import { createRuntime } from 'smaltnb/runtime';

const rt = createRuntime(source, {
  ts: smaltty,                          // smaltty, the TypeScript kit: reads, binds and strips TypeScript
  importModule: (spec) => import(spec), // loads what the setup cell imports; smaltnb itself is built in
  onChange: (state) => render(state),   // a copy of a cell's state whenever it changes
});

await rt.runAll();                       // every cell in order; actions only with { actions: true }
await rt.update(editedSource);           // an edit: changed cells and what follows react
await rt.run(['clean']);                 // the Run button
await rt.run(['write clean'], { force: true }); // run once even though its guard is false
rt.value('byRegion');                    // a name's current value
rt.states();                             // every cell's state, in file order
```

## How a cell runs

Each cell is compiled once (until its code changes) to an async function. It receives the names it reads, and returns
the names it defines and the value of its last expression, its output. Types are stripped, `export` is dropped (the
names stay visible to the rest of the notebook), and top-level `await` works in cells and in guards.

Types are stripped by smaltty: replaced with spaces, never compiled (TypeScript's `erasableSyntaxOnly`). Code that would
need compiling is an error on its cell, with the notebook's line and column and what to write instead:

| Instead of | Write |
| --- | --- |
| `enum Color { Red, Green }` | `const Color = { Red: 'red', Green: 'green' } as const` |
| `<number>x` | `x as number` |
| `constructor(private n: number) {}` | a field `n: number`, assigned in the constructor |
| `namespace N { export const x = 1 }` | an object: `const N = { x: 1 }` |

The setup cell loads its imports with `importModule`. `import type` and type-only names are dropped.

## Cell states

| Status | Meaning |
|---|---|
| `idle` | Hasn't run. |
| `running` | Running now. |
| `ok` | Ran, and its result is current. |
| `stale` | Its result is out of date: it was edited, an input changed, or an input isn't current. It keeps its last result and waits. |
| `skipped` | Its guard (or the guard of a cell it reads) was false. It keeps its last result. |
| `held` | It tried to write to the database without being an action or run on request. It keeps its last result; run it to let it write. |
| `error` | It threw, or the notebook has an error in it. `error` has the message. |

`reason` says why a cell is stale, skipped or failed: `edited, not run`, `an input changed`,
`inputs changed since last run` (an action), `waiting for "raw"`, `"a" was skipped`,
`when () => params.mode === 'full' is false`, or the error message.

## What reacts to what

- **`update(source)`**: cells whose code, reads, guard or run mode changed are changed. `auto` cells among them and
  after them run; `lazy` and `manual` cells, actions, and everything after them go stale. Removed cells are dropped.
- **`run(ids)`**: those cells run, whatever their run mode, and count as run for what follows.
- **`runAll()`**: every cell in order, whatever its run mode. Actions run only with `{ actions: true }`, as in a
  scheduled run.
- **Actions never run on their own.** After an input changes they show `inputs changed since last run`.
- A cell whose inputs aren't all current doesn't run: it waits (`stale`). A cell that reads a skipped cell is skipped
  too.
- Runs never interleave: calls queue and run one after another.

## Parameters

`createRuntime(source, { params, onParams })` takes parameter values as text (`{ minQty: '5' }`) and reports the
notebook's parameters (`ParamInfo`: name, kind, default, value, choices, declaring cell, and `error` for a value that
doesn't fit) whenever they change. `rt.setParams({ minQty: '7' })` sets values (null goes back to the default): the
declaring cell runs again, and what reads it reacts as to an edit. The kernel and `KernelClient` carry the same:
`open(source, fileName, params)`, `setParams`, `onParams`, `params`; a restart keeps the values.

## Controls

A cell's controls (`ui.*`) are in its state, `controls` (`ControlInfo`: index, kind, label, value, default, options,
min, max, step), as it declared them when it last ran; a cell that fails keeps the ones declared before the failure.
`rt.setControl(cell, index, value)` sets one (null goes back to the default): the cell runs again, and what reads it
reacts as to an edit. A value that doesn't fit the control is dropped for the default. The kernel and `KernelClient`
carry the same (`setControl`, and `controls` on each cell's view); a restart keeps the values.

## The kernel

In a page, cells run in a Web Worker, the kernel, so the page stays responsive and a cell that never finishes can be
stopped. `smaltnb/kernel` serves the runtime in the worker; `smaltnb/client` is the page's side.

```ts
// kernel-worker.ts
import { serveKernel } from 'smaltnb/kernel';
import { smaltty } from 'smaltkit/typescript';
serveKernel(self, { ts: smaltty, importModule: (spec) => import(spec) });
```

```ts
// the page
import { KernelClient } from 'smaltnb/client';

const kernel = new KernelClient(
  () => new Worker(new URL('./kernel-worker.js', import.meta.url), { type: 'module' }),
  { onState: (cell) => render(cell), onNotebook: (nb) => draw(nb.cells, nb.edges, nb.diagnostics) },
);
await kernel.open(source, 'regional.nb.ts');
await kernel.runAll();
await kernel.update(editedSource);
await kernel.restart();   // stop a run that never finishes
```

- **Restart** replaces the worker and opens the notebook again in the new one. Every cell goes back to `idle` with the
  reason `the kernel was restarted`, and requests that were waiting fail. The database has its own worker and is not
  touched.
- **Edits** reach the page at once: `onNotebook` gets the new cells, graph and diagnostics before anything reruns, even
  while a long cell is running.
- **Values stay in the kernel.** The page gets each cell's state and its output: the value itself when it can be cloned
  across, otherwise a description such as `[function load]`.
- **TypeScript** is read and stripped in the worker by smaltty, bundled into it from `smaltkit/typescript`: 35 KB
  gzipped, with nothing to fetch, where the TypeScript compiler it replaces was 8.7 MB loaded at run time.

## The database

Give the runtime a smaltdb database with smaltql and smaltdf registered, and smaltdf's `table` to read collected
results as frames:

```ts
import { Database, registerLanguage } from 'smaltdb/engine';   // or open() from smaltql, through a worker
import { sqlLanguage } from 'smaltql';
import { dfLanguage, table } from '@smaltdb/df';

registerLanguage(sqlLanguage);
registerLanguage(dfLanguage);
const rt = createRuntime(source, { ts, database: Database.openMemory(), frame: table, importModule });
```

In the kernel, `serveKernel(self, { …, database: () => open('notebook'), frame: table })` opens it once.

Cells import `sql`, `exec` and `db` from `smaltnb`:

```ts
cell('orders', { lang: 'df' });
export const orders = table('orders').filter(col('qty').ge(1));

cell('byRegion', { lang: 'sql' });
export const byRegion = sql`SELECT region, sum(qty * price) AS revenue FROM ${orders} GROUP BY region`;

action('save');
await exec`INSERT INTO region_totals SELECT * FROM ${byRegion}`;
```

- **Collected results.** When a cell finishes, each `sql` query and smaltdf frame it defines (and its output) is
  collected into a `TEMP` table named for the cell, `nb_<cell>_<name>`. The rows move inside the engine, not through
  the kernel. Later cells read the collected result: smaltdf as a frame over the table, SQL through `${}`. An edit
  re-collects, and a result that's gone has its table dropped. A cell with `live: true` isn't collected.
- **The SQL is the template's text as written** (its raw text): a backslash belongs to SQL (`LIKE 'a\_%'`); only
  `` \` `` and `\${` are unescaped.
- **`${}` in SQL** is a bound parameter for a value, the table of a collected result, or an identifier with
  `sql.id(name)`. Values are never spliced into the text, and a live (uncollected) frame is refused with a reason.
- **`exec`** runs a statement at once and resolves to `{ rows }`, the rows it changed.
- **Writes are checked by plan kind**, whatever the language: a plan whose kind isn't a query is a write, and so is
  SQL the engine reports as not read-only (a `TEMP` table too). In a cell that isn't an action, a write is `held`
  until you run the cell; an action writes when it runs. `db` passed to smaltdf (`frame.insertInto(db, 'orders')`) is
  checked the same way.
- **Outputs** that are collected results reach the page as a table with its first rows; `rows(cell, offset, limit)`
  (and `KernelClient.rows`) fetch more, for a grid that scrolls. The page never holds a whole result.

*Not yet:* through smaltdb's worker client, SQL text can't be classified until smaltdb reports whether a statement is
read-only there (in process it does), so until then `exec` counts as a write and a query as a read. Cells that read a
table an action wrote don't go stale yet: that needs plans to say which tables they read and write. Both are listed
in the [design](../DESIGN#needed-from-other-repositories). [The notebook page](./page) puts all of
this in a browser.
