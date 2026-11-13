// Builds the notebook page into a folder (default dist-app/): the page and its three workers bundled with esbuild (the
// kernel worker with smaltty, from smaltkit/typescript, and the type checker's, smaltkit/typecheck), with smaltkit's
// styles, the declarations the checker reads (types.bin prepared, types.json their text), the brand files and the demo
// notebook copied beside them.
//
//   node scripts/build-app.mjs [outdir]
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const out = process.argv[2] ?? 'dist-app';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    main: 'app/main.ts',
    'kernel-worker': 'app/kernel-worker.ts',
    'db-worker': 'app/db-worker.ts',
    'typecheck-worker': 'smaltkit/typecheck-worker.js',
  },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: out,
  sourcemap: true,
  minify: true,
  logLevel: 'warning',
});

cpSync(join(dirname(require.resolve('smaltkit/package.json')), 'dist/ui.css'), join(out, 'ui.css'));

// The type checker's setup (smaltkit/typecheck): the declarations of what notebooks import, smaltnb's own (dist/, from
// `npm install`) and smaltdf's, by the names they are imported by.
const types = {};
const declarations = (dir, prefix) => {
  for (const f of readdirSync(dir).sort()) if (f.endsWith('.d.ts')) types[`${prefix}/${f}`] = readFileSync(join(dir, f), 'utf8');
};
declarations('dist', '/nb');
declarations(join(dirname(require.resolve('@smaltdb/df/package.json')), 'dist'), '/df');
writeFileSync(join(out, 'types.json'), JSON.stringify({ files: types, packages: { smaltnb: '/nb/index.d.ts', '@smaltdb/df': '/df/index.d.ts' } }) + '\n');
// The same declarations prepared (smaltty's prepare(), milestone 11), which the checker reads in place of parsing their
// text: made by the smaltty bundled into the checker's worker (smaltkit's copy), which ignores a buffer another smaltty
// made and fetches types.json instead.
const { prepare } = await import(pathToFileURL(join(dirname(require.resolve('smaltkit/package.json')), 'dist/smaltty/entry-check.js')).href);
writeFileSync(join(out, 'types.bin'), prepare(types));
cpSync('app/index.html', join(out, 'index.html'));
cpSync('app/app.css', join(out, 'app.css'));
cpSync('app/brand', join(out, 'brand'), { recursive: true });
cpSync('examples/shop.nb.ts', join(out, 'demo.nb.ts'));
console.log(`build-app: ${out}/`);
