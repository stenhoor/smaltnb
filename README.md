# smaltnb

**Small. Alternative. Notebooks.**

Reactive notebooks for [smaltdb](https://github.com/stenhoor/smaltdb). A notebook is a TypeScript file: cells are
top-level code, the graph comes from the names they define and read, and `export` makes a notebook a library other
notebooks import. TypeScript, SQL ([smaltql](https://github.com/stenhoor/smaltql)) and dataframes
([smaltdf](https://github.com/stenhoor/smaltdf)) are first-class.

Inspired by marimo, Jupyter and JupyterLab.

> **Status: design and early development.** Nothing runs yet. See [docs/DESIGN.md](docs/DESIGN.md).

```ts
import { cell, sql } from 'smaltnb';
import { col } from '@smaltdb/df';

cell('raw', { lang: 'sql' });
export const raw = sql`SELECT region, qty, price FROM orders`;

cell('clean', { lang: 'df' });
export const clean = raw.filter(col('qty').gt(0));
```

## License

MIT
