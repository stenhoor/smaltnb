# CLAUDE.md

smaltnb is reactive notebooks for [smaltdb](https://github.com/stenhoor/smaltdb). The design and the owner's
decisions are in [docs/DESIGN.md](docs/DESIGN.md): read it before changing behaviour. Several Claude Code sessions work
on the smalt repos in parallel and cannot see each other: this file is the shared starting point. smaltkit, smaltui and
smaltdb have matching files; keep the working rules the same.

## Brand: read smalt-brand first

Before changing this repository's site, README, or how it describes the product, read smalt-brand's
[BRAND.md](https://github.com/stenhoor/smalt-brand/blob/main/BRAND.md) (the family table, and "Sites and READMEs", the
standard every product site and README follows) and
[DECISIONS.md](https://github.com/stenhoor/smalt-brand/blob/main/DECISIONS.md). A newer decision there wins over any
copy here: lines and roles change, and a copy taken before the change is out of date.

- Copy brand files and the site kit (`themes/vitepress/`) unchanged. To change them, change smalt-brand first, then
  copy them again.
- A change to this product's status or to what it does comes with a smalt-brand PR that updates smaltworks.dev (its
  status page and this product's page), linked with `Depends on:`.

## Commands

```bash
npm install            # prepare builds dist/ (tsc -p tsconfig.build.json: TypeScript 6.0.3, which emits)
npm run deps           # smaltdb, smaltql, smaltdf pinned in packed.json (scripts/fetch-packed.mjs); again after each npm install
npm run typecheck      # TypeScript 7's tsc (typescript7), strict, no emit, over src/, test/, examples/ and app/ (CI runs it)
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
- No runtime dependencies unless agreed. smaltty, the TypeScript kit, is passed in by the caller (`smaltty` from
  `smaltkit/typescript`), never imported by `src/` except as types.
- smaltql and smaltdf are reached only through smaltdb's plan layer and language registry, never by importing their
  internals.
- UI that smaltui or smaltbi could use belongs in smaltkit, not here (DESIGN.md decision 20).
- No app names in user-facing text.
- **Keep the documents current.** A PR that changes behaviour updates the pages that describe it in the same PR:
  `docs/guide/` (the format reference, notebooks, status), `docs/DESIGN.md` when a decision changes, and the README.
  Mark what isn't built yet as *planned*.

## Working rules for sessions

- One task per branch and PR. Do not add unrelated work to an open PR: it holds up everything else in it.
- Never stack PRs: branch from `main`, target `main`, and wait for a dependency to merge before opening the work that
  needs it.
- Mark unfinished work clearly, and open a PR only when CI passes.
- Read review comments on your PR and answer them with commits that say what they address.
- When a PR depends on another repo's PR, add a line such as `Depends on: stenhoor/smalt-brand#2`.
- **Ask before adding outside code.** Ask the owner, and wait for a yes, before adding a package (a dependency of any
  kind, or a pin in `packed.json`), copying or bundling in someone else's code, or loading code from another site at run
  time (a CDN such as jsDelivr). Say what it is, its licence and size, what it's for, and why our own code can't do it.
  Outside code that a feature needs goes in a plugin, so it is named and optional, never in core.

## Cross-repo impact

- **smaltkit:** shared UI (editor, grid, chart, controls) and the engine loader come from smaltkit, pinned to a commit
  (`github:stenhoor/smaltkit#<commit>`) until it is on npm.
- **smaltdb, smaltql, smaltdf:** what smaltnb needs from them is listed in DESIGN.md. Raise it there as its own issue or
  PR, and note the dependency here.
- **smalt-brand:** colours come from the brand tokens, never hand-picked hex values. The mark is the Pencil.
