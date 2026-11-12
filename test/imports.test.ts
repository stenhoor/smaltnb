// Notebooks importing notebooks (DESIGN.md decisions 14 and 15). Runs against the built package (dist/), with smaltdb's
// in-process engine, smaltql and smaltdf (pinned in packed.json: `npm run deps`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { smaltty as ts } from 'smaltkit/typescript';
import { Database, registerLanguage } from 'smaltdb/engine';
import { sqlLanguage } from 'smaltql';
import * as df from '@smaltdb/df';
import { createRuntime, resolveNotebookPath, type RuntimeOptions } from 'smaltnb/runtime';
// @ts-expect-error: the command has no declarations
import { main } from '../dist/cli/smaltnb.js';

registerLanguage(sqlLanguage);
registerLanguage(df.dfLanguage);

/** A runtime whose notebook imports read from `files`, by path. */
function withFiles(files: Record<string, string>, entry: string, options: Partial<RuntimeOptions> = {}) {
  const reads: string[] = [];
  const rt = createRuntime(files[entry]!, {
    ts, fileName: entry, ...options,
    readNotebook: async (path) => {
      reads.push(path);
      if (!(path in files)) throw new Error(`no file ${path}`);
      return files[path]!;
    },
  });
  return { rt, reads };
}

const lib = `import { cell, action } from 'smaltnb';
cell('base'); export const base = 20;
cell('answer'); export const answer = base + 22;
cell('unused'); export const unused = (() => { throw new Error('unused ran'); })();
action('wipe'); throw new Error('the action ran');
`;

test('resolveNotebookPath: relative to the importing file\'s folder, with . and ..', () => {
  assert.equal(resolveNotebookPath('main.nb.ts', './lib.nb.ts'), 'lib.nb.ts');
  assert.equal(resolveNotebookPath('a/main.nb.ts', './lib/x.nb.ts'), 'a/lib/x.nb.ts');
  assert.equal(resolveNotebookPath('a/b/main.nb.ts', '../x.nb.ts'), 'a/x.nb.ts');
  assert.equal(resolveNotebookPath('main.nb.ts', '../up.nb.ts'), '../up.nb.ts');
});

test('importing runs only the cells the imported names need: never the others, never an action', async () => {
  const { rt, reads } = withFiles({
    'main.nb.ts': `import { cell } from 'smaltnb';\nimport { answer as a } from './lib/lib.nb.ts';\ncell('use'); export const twice = a * 2;\n`,
    'lib/lib.nb.ts': lib,
  }, 'main.nb.ts');
  await rt.runAll();
  assert.equal(rt.state('setup')!.status, 'ok', rt.state('setup')!.reason ?? '');
  assert.equal(rt.value('twice'), 84);
  assert.deepEqual(reads, ['lib/lib.nb.ts']);
});

test('import * gets every export; nested imports resolve from the imported notebook\'s folder', async () => {
  const { rt, reads } = withFiles({
    'main.nb.ts': `import { cell } from 'smaltnb';\nimport * as m from './a/mid.nb.ts';\ncell('use'); export const got = m.doubled;\n`,
    'a/mid.nb.ts': `import { cell } from 'smaltnb';\nimport { base } from '../b/leaf.nb.ts';\ncell('d'); export const doubled = base * 2;\n`,
    'b/leaf.nb.ts': `import { cell } from 'smaltnb';\ncell('base'); export const base = 21;\n`,
  }, 'main.nb.ts');
  await rt.runAll();
  assert.equal(rt.value('got'), 42);
  assert.deepEqual(reads, ['a/mid.nb.ts', 'b/leaf.nb.ts']);
});

test('what an import can\'t do is an error on the setup cell, with the reason', async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ 'm.nb.ts': `import { cell } from 'smaltnb';\nimport { nope } from './lib.nb.ts';\ncell('x');\n`, 'lib.nb.ts': lib },
      /lib\.nb\.ts doesn't export "nope" \(it exports "base", "answer", "unused"\)/],
    [{ 'm.nb.ts': `import { cell } from 'smaltnb';\nimport { unused } from './lib.nb.ts';\ncell('x');\n`, 'lib.nb.ts': lib },
      /lib\.nb\.ts: cell "unused" failed: unused ran/],
    [{ 'm.nb.ts': `import { cell } from 'smaltnb';\nimport { x } from './gone.nb.ts';\ncell('y');\n` },
      /Can't import '\.\/gone\.nb\.ts': no file gone\.nb\.ts/],
    [{ 'm.nb.ts': `import { cell } from 'smaltnb';\nimport { b } from './b.nb.ts';\ncell('y'); export const a = b;\n`,
       'b.nb.ts': `import { cell } from 'smaltnb';\nimport { a } from './m.nb.ts';\ncell('b'); export const b = a + 1;\n` },
      /Notebooks import each other: m\.nb\.ts → b\.nb\.ts → m\.nb\.ts/],
    [{ 'm.nb.ts': `import { cell } from 'smaltnb';\nimport lib from './lib.nb.ts';\ncell('y');\n`, 'lib.nb.ts': lib },
      /a notebook's default export, its typed factory, is planned/],
  ];
  for (const [files, message] of cases) {
    const { rt } = withFiles(files, 'm.nb.ts');
    await rt.runAll();
    const s = rt.state('setup')!;
    assert.equal(s.status, 'error', String(message));
    assert.match(s.error!.message, message);
  }
  const bare = createRuntime(`import { cell } from 'smaltnb';\nimport { a } from './lib.nb.ts';\ncell('y');\n`, { ts });
  await bare.runAll();
  assert.match(bare.state('setup')!.error!.message, /importing a notebook needs its folder, which this notebook isn't given/);
});

test('a collected result crosses an import: SQL and smaltdf read it, and same-named cells keep separate tables', async () => {
  const db = Database.openMemory();
  db.exec(readFileSync(new URL('../examples/shop.sql', import.meta.url), 'utf8'));
  const dir = new URL('../examples/', import.meta.url);
  const rt = createRuntime(readFileSync(new URL('report.nb.ts', dir), 'utf8'), {
    ts, fileName: 'report.nb.ts', database: db, frame: df.table, importModule: async () => df,
    readNotebook: async (p) => readFileSync(new URL(p, dir), 'utf8'),
  });
  await rt.runAll();
  assert.equal(rt.state('byRegion')!.status, 'ok', rt.state('byRegion')!.reason ?? '');
  assert.deepEqual(rt.state('byRegion')!.outputTable!.preview.rows, [['west', 2400], ['east', 1240], ['south', 198.25], ['north', 79.5]]);
  assert.equal(db.query("SELECT count(*) FROM orders WHERE qty = 0").rows[0]![0], 1, 'the imported notebook\'s action did not run');
  // The importer has a cell named like the imported one's: their collected tables don't collide.
  const clash = createRuntime(`import { cell, sql } from 'smaltnb';\nimport { orders as cleaned } from './orders.nb.ts';\ncell('orders', { lang: 'sql' });\nexport const orders = sql\`SELECT count(*) AS n FROM \${cleaned}\`;\norders;\n`, {
    ts, fileName: 'clash.nb.ts', database: db, frame: df.table, importModule: async () => df,
    readNotebook: async (p) => readFileSync(new URL(p, dir), 'utf8'),
  });
  await clash.runAll();
  assert.equal(clash.state('orders')!.status, 'ok', clash.state('orders')!.reason ?? '');
  assert.deepEqual(clash.state('orders')!.outputTable!.preview.rows, [[7]]);
  const tables = db.query("SELECT name FROM temp.sqlite_schema WHERE type = 'table' AND name LIKE 'nb_%orders%' ORDER BY name").rows.map((r) => r[0]);
  assert.equal(tables.length, 2, `two tables: ${tables.join(', ')}`);
});

test('smaltnb run imports from the notebook\'s folder', async () => {
  let out = '';
  let err = '';
  const code = await main(['run', new URL('../examples/report.nb.ts', import.meta.url).pathname, '--init', new URL('../examples/shop.sql', import.meta.url).pathname],
    { out: (s: string) => void (out += s), err: (s: string) => void (err += s) });
  assert.equal(code, 0, err + out);
  assert.match(out, /✓ byRegion {2}4 rows/);
});
