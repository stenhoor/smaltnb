// Builds the notebook page into a folder (default dist-app/): the page and its two workers bundled with esbuild (the
// kernel worker with smaltty, from smaltkit/typescript), with smaltkit's styles, the brand files and the demo notebook
// copied beside them.
//
//   node scripts/build-app.mjs [outdir]
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const out = process.argv[2] ?? 'dist-app';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { main: 'app/main.ts', 'kernel-worker': 'app/kernel-worker.ts', 'db-worker': 'app/db-worker.ts' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: out,
  sourcemap: true,
  minify: true,
  logLevel: 'warning',
});

cpSync(join(dirname(require.resolve('smaltkit/package.json')), 'dist/ui.css'), join(out, 'ui.css'));
cpSync('app/index.html', join(out, 'index.html'));
cpSync('app/app.css', join(out, 'app.css'));
cpSync('app/brand', join(out, 'brand'), { recursive: true });
cpSync('examples/shop.nb.ts', join(out, 'demo.nb.ts'));
console.log(`build-app: ${out}/`);
