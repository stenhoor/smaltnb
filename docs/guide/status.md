# Status

smaltnb is in early development and not published. This page says what is in, as of 2026-11-07. The plan is the
[order of work](../DESIGN#order-of-work) in the design.

| Step | What | State |
|---|---|---|
| 0 | **Format and graph**: the `.nb.ts` parser, the graph, the rules and their diagnostics | In ([the format](./format)) |
| 1 | **Run**: [the runtime](./runtime), [the kernel](./runtime#the-kernel), [the database](./runtime#the-database) and [the notebook page](./page) | In, except `md` |
| 2 | **Git**: a repository in the browser (OPFS), synced with GitHub; per-cell diffs and commits | Planned |
| 3 | **Libraries**: notebook imports, the typed factory, `smaltnb build` | Planned |
| 4 | **Types and UI**: pinned row types, `ui.*` controls, charts, the on-disk result store | Planned |
| 5 | **Headless**: `smaltnb run` in Node and GitHub Actions | Planned |

## Depends on

smaltql and smaltdf are still changing; smaltnb reaches them only through smaltdb's plan layer, so it follows their
changes. What the runtime needs from smaltdb, smaltql, smaltdf and smaltkit is listed in the
[design](../DESIGN#needed-from-other-repositories).
