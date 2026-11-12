# The notebook page

**[Open a notebook](/app/){target="_self"}**: it runs entirely in your browser. The first time, it
opens a demo notebook over a small `orders` table and runs it.

## Using it

- **Cells** are the notebook's `cell()` and `action()` sections, each in its own editor. Edit a cell and, after a short
  pause, the notebook reacts: cells that read what changed run again, lazy and manual cells and actions go stale.
- **SQL cells** show only their SQL. A query cell's result is named after the cell, and `${name}` (marked in the
  editor) reads another cell's result. An action of SQL statements shows them as a script, one per `;`. What you type
  is saved in the file in its TypeScript form, `` export const name = sql`…`; `` (see
  [plain SQL cells](./format#plain-sql-cells)). **TS** on a SQL cell shows that TypeScript, and **SQL** goes back.
  A cell that holds more than SQL shows as TypeScript.
- **Text cells** (`lang: 'md'`) show their Markdown to edit, rendered below. `${value}` puts a notebook value in the
  text, so prose follows the parameters. **TS** shows the TypeScript, **MD** goes back. Raw HTML in the text shows as
  text.
- **Graph** shows how the cells depend on each other: a box per cell, left to right by depth, in its status colour,
  and an arrow for each name a cell reads from another (dashed when only its guard reads it). Hover a box to bring
  forward what it reads and what reads it; click it to go to the cell. It stays open across reloads in this browser.
- **Source** shows the whole notebook as its `.nb.ts` file, editable; **Cells** goes back.
- **Parameters** declared with `param()` show in a bar under the header. A change reruns what reads them and goes into
  the page's address (`?minQty=5`), so a link opens the notebook with those values.
- **Controls** (`ui.*`) show under the cell that declares them. A change runs the cell again.
- **Run** runs one cell (`Ctrl+Enter`; `Shift+Enter` runs it and moves to the next). **Run all** runs every cell;
  actions run only from their own Run button.
- **Status** shows on each cell's edge and header: ok, stale, skipped, held, error, with the reason.
  - **Held:** a cell that isn't an action tried to write to the database. Its button reads **Run and write**.
  - **Skipped:** a cell whose guard was false offers **Run once anyway**.
- **Results** that are tables show in a grid with their row count. The page loads only the rows you scroll to, so a
  large result stays cheap. **Download CSV** saves every row.
- **Row types:** after a SQL cell runs, **Pin types** writes its result's row type into the notebook
  (`sql<{ … }>`); a later run that no longer matches shows **types out of date** and **Update types**. See
  [Row types](./notebooks#row-types).
- **Charts** (`chart.bar(…)` and the others, as a cell's last expression) are drawn below the cell, and again when it
  reruns. A chart of more than 5,000 rows is drawn from the first 5,000, and says so.
- **Restart** stops a cell that never finishes, by replacing the kernel. The cells' results are lost and the database
  is kept.
- **+ SQL**, **+ Text**, **+ Cell** and **+ Action** add a SQL cell, a text cell, a TypeScript cell or an action at the end. **Open…** loads a `.nb.ts` file, **Download** saves the notebook
  as one, and **Demo** brings the demo back.

The notebook you're working on is kept in this browser, and its database in the browser's private storage (OPFS); in
a private window the database is in memory.

## Not yet

These are planned: notebooks in git, and completion from a TypeScript language service. See [Status](./status).

## Run it locally

```bash
npm install && npm run deps
```

```bash
npm run app          # builds the page into dist-app/ and serves it at http://localhost:8090/
```

```bash
npm run e2e          # builds it and drives it in headless Chromium
```

`npm run e2e` needs Playwright, installed outside the project and found through `NODE_PATH`; see `test/e2e/app.mjs`.

The page and its three workers are bundled with esbuild: the page, the kernel worker (cell code, with smaltty for
TypeScript, from `smaltkit/typescript`), the database's engine worker (smaltdb with smaltql and smaltdf), and the type
checker's worker (`smaltkit/typecheck`). The editor and the grid come from smaltkit.

As you type, the type checker reads the notebook's calls into smaltnb and smaltdf against their declarations
(`types.json`, written by the build from smaltnb's `dist/` and smaltdf's `.d.ts`). It marks what TypeScript would call
an error in the cell it is in: a method that doesn't exist (with TypeScript's *Did you mean …?*), an argument too many
or too few, or of the wrong type. These are warnings: the text is underlined and the line number marked, with the
message on hover, and the notebook still runs. A cell showing its SQL or Markdown has its warnings in the TS view and in
Source. The checker reports only what `tsc` reports too, and is quiet about what it doesn't model, so `npm run
typecheck` stays the full check for a notebook in a project.
