# Headless runs

`smaltnb run` runs a notebook in Node from start to end, as a scheduled run does: every cell in order, with
parameters given on the command line, and the actions too when you ask for them. It prints each cell's status, writes
the run as JSON or Markdown, and exits 1 when a cell failed, so a script or a CI job can check it.

```sh
smaltnb run regional.nb.ts --param mode=full --param since=2026-10-01 --actions --init schema.sql --report run.json
```

```
regional.nb.ts (with actions)
  param mode = full (default incremental)
  param since = 2026-10-01
  ✓ raw  1,204 rows · 31 ms
  ✓ clean  1,198 rows · 12 ms
  ✓ byRegion  4 rows · 8 ms
  ✓ write clean (action)  22 ms
ok: 6 cells in 96 ms
```

## Options

| Option | Meaning |
|---|---|
| `--param name=value` | Sets a [parameter](./notebooks#parameters), as text, checked as in the page. Repeat for more. |
| `--actions` | Runs the notebook's actions too, once each, in file order. Without it, a run only reads. |
| `--init file.sql` | Runs this SQL before the notebook, to create or fill tables. Repeat for more. |
| `--db file` | Keeps the database in this file, with [smaltdb Node](https://github.com/stenhoor/smaltdb-node). Without it, the database is in memory and gone after the run. |
| `--report file.json` | Writes the run as JSON: each cell's status, reason, time and output (tables as their first rows). |
| `--md file.md` | Writes the run as Markdown: a status table, then each output. `--md -` adds it to the GitHub Actions job summary. |
| `--rows n` | Rows of each table kept in the reports (default 20). |
| `--quiet` | Prints only the last line. |

- **Exit codes:** 0 when every cell ran or was skipped by its guard. 1 when a cell failed, was held, or waits for one
  that failed; the report says which and why. 2 when the command couldn't run (a usage error, a missing package, an
  `--init` file that fails).
- **What runs:** every cell, whatever its run mode, as **Run all** does in the page. [Controls](./notebooks#controls)
  take their defaults.
- **Imports:** [other notebooks](./notebooks#notebooks-as-libraries) (`./orders.nb.ts`) are read from the notebook's
  folder. Packages are loaded from its folder's `node_modules` first, then from smaltnb's.
- **Packages:** the command needs smaltkit (which reads the TypeScript), smaltdb, smaltql, and smaltdf for frames:
  smaltnb's optional peer dependencies, loaded only when the command runs. `--db` also needs smaltdb Node. A missing
  one is named, with how to install it.

## In GitHub Actions

The repository is a GitHub Action:

```yaml
- uses: actions/checkout@v4
- uses: stenhoor/smaltnb@main
  with:
    notebook: notebooks/regional.nb.ts
    params: |
      mode=full
      since=2026-10-01
    actions: 'true'
    init: notebooks/schema.sql
    report: run.json
```

The run goes into the job summary (`summary: 'false'` turns that off), and the step fails when the run does. Inputs
reach the run as environment variables, never as text inside its script. Secrets stay secret: a notebook reads none,
and the action adds none.

## Building libraries

`smaltnb build` writes notebooks as libraries, with a typed factory for apps and other notebooks: see
[Built notebooks](./notebooks#built-notebooks-the-typed-factory).

## From code

`runNotebook(source, options)` from `smaltnb/report` is the same run without Node: it takes the
[runtime's options](./runtime) and gives the report; `reportText`, `reportJson` and `reportMarkdown` write it.

*Planned:* a run that writes only when its inputs changed, and a cron-style schedule in the page.
