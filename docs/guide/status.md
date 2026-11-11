# Status

smaltnb is in early development and not published. This page says what is in, as of 2026-11-08. The plan is the
[order of work](../DESIGN#order-of-work) in the design.

| Step | What | State |
|---|---|---|
| 0 | **Format and graph**: the `.nb.ts` parser, the graph, the rules and their diagnostics | In ([the format](./format)) |
| 1 | **Run**: [the runtime](./runtime), [the kernel](./runtime#the-kernel), [the database](./runtime#the-database) and [the notebook page](./page) | In |
| 2 | **Git**: a repository in the browser (OPFS), synced with GitHub; per-cell diffs and commits | Planned |
| 3 | **Libraries**: notebook imports, the typed factory, `smaltnb build` | Planned |
| 4 | **Types and UI**: pinned row types, `ui.*` controls, charts, the on-disk result store | Planned |
| 5 | **Headless**: `smaltnb run` in Node and GitHub Actions | Planned |

TypeScript is read, bound and stripped by [smaltty](https://stenhoor.github.io/smaltty/) (from `smaltkit/typescript`)
since 2026-11-08, in place of the TypeScript compiler: the page no longer loads 8.7 MB before its first run. Since
2026-11-11 its checker marks the TypeScript errors in calls into smaltnb and smaltdf as you type, as warnings.

## Depends on

smaltql and smaltdf are still changing; smaltnb reaches them only through smaltdb's plan layer, so it follows their
changes. What the runtime needs from smaltdb, smaltql, smaltdf and smaltkit is listed in the
[design](../DESIGN#needed-from-other-repositories).
