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
- **Source** shows the whole notebook as its `.nb.ts` file, editable; **Cells** goes back.
- **Parameters** declared with `param()` show in a bar under the header. A change reruns what reads them and goes into
  the page's address (`?minQty=5`), so a link opens the notebook with those values.
- **Run** runs one cell (`Ctrl+Enter`; `Shift+Enter` runs it and moves to the next). **Run all** runs every cell;
  actions run only from their own Run button.
- **Status** shows on each cell's edge and header: ok, stale, skipped, held, error, with the reason.
  - **Held:** a cell that isn't an action tried to write to the database. Its button reads **Run and write**.
  - **Skipped:** a cell whose guard was false offers **Run once anyway**.
- **Results** that are tables show in a grid with their row count. The page loads only the rows you scroll to, so a
  large result stays cheap. **Download CSV** saves every row.
- **Restart** stops a cell that never finishes, by replacing the kernel. The cells' results are lost and the database
  is kept.
- **+ SQL**, **+ Text**, **+ Cell** and **+ Action** add a SQL cell, a text cell, a TypeScript cell or an action at the end. **Open…** loads a `.nb.ts` file, **Download** saves the notebook
  as one, and **Demo** brings the demo back.

The notebook you're working on is kept in this browser, and its database in the browser's private storage (OPFS); in
a private window the database is in memory.

## Not yet

These are planned: notebooks in git, the graph view, `ui` and charts, type pinning, and completion from
a TypeScript language service. See [Status](./status).

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

The page and its two workers are bundled with esbuild: the page, the kernel worker (cell code, with smaltty for
TypeScript, from `smaltkit/typescript`), and the database's engine worker (smaltdb with smaltql and smaltdf). The
editor and the grid come from smaltkit.
