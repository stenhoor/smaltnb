---
layout: home

hero:
  name: 'sm<span class="alt">alt</span><span class="suffix">nb</span>'
  text: Small. Alternative. Notebooks.
  tagline: Reactive notebooks in TypeScript for smaltdb.
  image:
    light: /pencil-mark.svg
    dark: /pencil-mark-on-dark.svg
    alt: smaltnb
  actions:
    - theme: brand
      text: Notebooks
      link: /guide/notebooks
    - theme: alt
      text: The format
      link: /guide/format
    - theme: alt
      text: Status
      link: /guide/status

features:
  - title: A notebook is a TypeScript file
    details: A .nb.ts file is a valid TypeScript module that tsc checks as written. Diffs are code diffs, and any editor opens it.
    link: /guide/format
    linkText: The format
  - title: Reactive
    details: Cells are top-level code. Change one and the cells that read it rerun; lazy cells and cells that write wait for you.
    link: /guide/notebooks#reactive
    linkText: How cells react
  - title: Guards
    details: A cell can declare a typed when() condition over the notebook's values. A guarded cell that doesn't run says why.
    link: /guide/notebooks#guards
    linkText: Guards
  - title: SQL and dataframes
    details: smaltql and smaltdf are first-class. Both build plans for smaltdb's engine, and a result of one feeds the other.
    link: /guide/notebooks#sql-and-dataframes
    linkText: SQL and dataframes
  - title: Notebooks you can import
    details: export marks a notebook's public API. Importing a notebook runs only what its exports need, so notebooks become libraries.
    link: /guide/notebooks#notebooks-as-libraries
    linkText: Libraries
  - title: Versioned in git
    details: Notebooks live in a git repository, in the browser, synced with GitHub. Secrets stay secret, never in a notebook or a repo.
    link: /DESIGN
    linkText: The design
---

<p style="text-align:center;margin-top:2.5rem;color:var(--vp-c-text-2)">Inspired by marimo, Jupyter and JupyterLab. In early development: see <a href="./guide/status">Status</a>.</p>
