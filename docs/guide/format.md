# The notebook format

A notebook is a TypeScript module named `*.nb.ts`. It typechecks with `tsc` as written: the format adds no syntax of
its own, only two functions from `smaltnb` whose calls mark where cells start. This page is the reference for what
`smaltnb/format` and `smaltnb/graph` implement today.

## Cells

```ts
import { cell, action } from 'smaltnb';   // setup: imports only

cell('raw');                               // a reactive cell named raw
export const raw = [1, 2, 3];

cell('total', { run: 'lazy' });            // options are an object literal
export const total = raw.reduce((a, b) => a + b, 0);
total;                                     // the last expression is the cell's output

action('log', { when: () => total > 5 });  // a cell that writes
console.log(total);
```

- **Setup.** Code before the first `cell()` or `action()` is the setup cell, and holds imports only. Imports belong
  there and nowhere else.
- **Boundaries.** A top-level statement `cell(name, options?)` or `action(name, options?)` starts a cell. They can be
  imported under other names (`import { cell as c } from 'smaltnb'`).
- **Names.** The first argument is a string literal, unique in the notebook.
- **Output.** A cell that ends with an expression statement shows that expression as its output.
- **Default export.** Reserved: it will be the notebook's typed factory, so cells can't `export default`.

## Options

Options are read from the source without running the notebook, so they must be literals.

| Option | Values | Cells | Meaning |
|---|---|---|---|
| `lang` | `'ts'`, `'sql'`, `'df'`, `'md'` | both | The language the cell is shown and edited in. |
| `run` | `'auto'`, `'lazy'`, `'manual'` | `cell` | How the cell reacts when an input changes. |
| `when` | a function, `() => boolean` | both | A guard: the cell runs only while it returns true. |
| `store` | `'memory'`, `'opfs'` | `cell` | Where its collected result is kept. |
| `live` | `true`, `false` | `cell` | Bind the result as a view instead of collecting it. |
| `hide` | `true`, `false` | both | Hide the cell's code. |

An action has no `run`, `store` or `live`: it never reruns on its own.

## Names and the graph

`parseNotebook(source, ts)` resolves names with the TypeScript compiler, so it sees what TypeScript sees: a parameter or
property named like a top-level value is not a read, `{ raw }` is, and a name used only as a type (`o: Order`,
`implements Shape`) is a type read, which matters to the compiler but not to a run.

For each cell it gives `defines`, `exports`, `reads`, `typeReads`, the guard's reads, its options and its spans.

## The graph

`buildGraph(notebook)` turns reads into edges, from the cell that defines a name to each cell that reads it (`value`),
or whose guard reads it (`guard`).

| Function | Gives |
|---|---|
| `graph.order` | The run order: file order whenever the notebook reads top to bottom. |
| `upstream(graph, ids)`, `downstream(graph, ids)` | What the cells depend on, or what depends on them, in run order. |
| `exportClosure(graph, names)` | The cells that importing these exports needs, and names that aren't exported. |
| `propagate(graph, changed)` | Which cells run and which go stale after a change. |

## Rules and diagnostics

| Code | Severity | When |
|---|---|---|
| `no-cells` | warning | Nothing is imported as `cell` or `action` from `smaltnb`. |
| `setup-code` | error | Code other than imports before the first cell. |
| `import-in-cell` | error | An import after the first cell. |
| `cell-name` | error | A cell's name is missing or not a string literal. |
| `cell-arguments` | error | More than a name and an options object. |
| `cell-options` | error | Options that aren't an object literal, unknown keys, or values outside the table above. |
| `duplicate-name` | error | Two cells with the same name. |
| `defined-later` | error | A cell reads a name defined further down (function declarations excepted). |
| `assign-elsewhere` | error | A top-level name is assigned outside the cell that defines it. |
| `export-default` | error | A cell exports default. |
| `export-from` | error | A re-export from another module. |
| `export-unknown` | error | An `export { x }` of a name the notebook doesn't define. |
| `cycle` | error | Cells that depend on each other (possible only through function declarations). |
| `export-from-action` | error | An action exports a name: importing never runs actions. |
| `export-needs-action` | error | An export depends on an action. |
