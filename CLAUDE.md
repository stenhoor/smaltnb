# CLAUDE.md

smaltnb is reactive notebooks for [smaltdb](https://github.com/stenhoor/smaltdb). The design and the owner's
decisions are in [docs/DESIGN.md](docs/DESIGN.md): read it before changing behaviour. Several Claude Code sessions work
on the smalt repos in parallel and cannot see each other: this file is the shared starting point. smaltkit, smaltui and
smaltdb have matching files; keep the working rules the same.

## Commands

```bash
npm install            # prepare builds dist/ (tsc -p tsconfig.build.json)
npm run deps           # smaltdb, smaltql, smaltdf pinned in packed.json (scripts/fetch-packed.mjs); again after each npm install
npm run typecheck      # tsc --noEmit, strict, over src/, test/ and examples/ (CI runs it)
npm test               # build, then node --test test/*.test.ts against the built package
npm run app            # build the notebook page (scripts/build-app.mjs, esbuild) and serve it on :8090
npm run e2e            # build it and drive it in headless Chromium (Playwright, installed with --no-save)
npm run docs:dev       # the docs site (VitePress) with live reload; docs:build fails on dead links
```

## Repo map

- `src/` holds the modules (strict TypeScript), each a subpath export, re-exported from `src/index.ts`. Keep relative
  imports as `./name.js`.
- `app/` is the notebook page: the page, the kernel worker and the database worker, bundled by `scripts/build-app.mjs`
  (the only bundled code; `src/` stays bundler-free). The Docs workflow deploys it at `/smaltnb/app/`.
- `examples/*.nb.ts` are notebooks. They must typecheck as written: that is the format's promise.
- `test/*.test.ts` import the package by name, so they test the built output.
- `docs/` is the product site, deployed from `main` to GitHub Pages (`.github/workflows/docs.yml`) at `/smaltnb/` until
  it has a domain (`DOCS_BASE` in `docs/.vitepress/config.ts`). `docs/DESIGN.md` holds the owner's decisions.
  `docs/brand/` is copied from smalt-brand: don't edit it here.
- `dist/` and `node_modules/` are generated: do not edit or commit them.

## Rules for code here

- Browser-first: `src/` uses no Node APIs and no DOM framework, and its output loads in a page without a bundler.
- No runtime dependencies unless agreed. The TypeScript compiler is passed in by the caller (loaded at run time in
  the browser, imported in Node), never imported by `src/` except as types.
- smaltql and smaltdf are reached only through smaltdb's plan layer and language registry, never by importing their
  internals.
- UI that smaltui or smaltbi could use belongs in smaltkit, not here (DESIGN.md decision 20).
- No app names in user-facing text.
- **Keep the documents current.** A PR that changes behaviour updates the pages that describe it in the same PR:
  `docs/guide/` (the format reference, notebooks, status), `docs/DESIGN.md` when a decision changes, and the README.
  Mark what isn't built yet as *planned*.

## Working rules for sessions

- One task per branch and PR. Do not add unrelated work to an open PR: it holds up everything else in it.
- Mark unfinished work clearly, and open a PR only when CI passes.
- Read review comments on your PR and answer them with commits that say what they address.
- When a PR depends on another repo's PR, add a line such as `Depends on: stenhoor/smalt-brand#2`.

## Cross-repo impact

- **smaltkit:** shared UI (editor, grid, chart, controls) and the engine loader come from smaltkit, pinned to a commit
  (`github:stenhoor/smaltkit#<commit>`) until it is on npm.
- **smaltdb, smaltql, smaltdf:** what smaltnb needs from them is listed in DESIGN.md. Raise it there as its own issue or
  PR, and note the dependency here.
- **smalt-brand:** colours come from the brand tokens, never hand-picked hex values. The mark is the Pencil.
