# The runtime

`smaltnb/runtime` runs a notebook. It is the core the [kernel](#the-kernel) serves to the page and, later, headless
runs use. It has no database or page of its own yet: those come next in [milestone 1](./status).

```ts
import ts from 'typescript';
import { createRuntime } from 'smaltnb/runtime';

const rt = createRuntime(source, {
  ts,                                   // the TypeScript compiler: imported in Node, loaded at run time in a page
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

The setup cell loads its imports with `importModule`. `import type` and type-only names are dropped.

## Cell states

| Status | Meaning |
|---|---|
| `idle` | Hasn't run. |
| `running` | Running now. |
| `ok` | Ran, and its result is current. |
| `stale` | Its result is out of date: it was edited, an input changed, or an input isn't current. It keeps its last result and waits. |
| `skipped` | Its guard (or the guard of a cell it reads) was false. It keeps its last result. |
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

## The kernel

In a page, cells run in a Web Worker, the kernel, so the page stays responsive and a cell that never finishes can be
stopped. `smaltnb/kernel` serves the runtime in the worker; `smaltnb/client` is the page's side.

```ts
// kernel-worker.ts
import { serveKernel, loadTypeScript } from 'smaltnb/kernel';
serveKernel(self, { ts: loadTypeScript(), importModule: (spec) => import(spec) });
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
- **The TypeScript compiler** is loaded in the worker at run time: `loadTypeScript()` fetches `lib/typescript.js`
  (from jsDelivr by default, or the app's own copy) and evaluates it, with no bundler.

*Planned in milestone 1:* `db`, `sql` and `exec`; cells that write, decided by the plans they send; collected results;
the notebook page.
