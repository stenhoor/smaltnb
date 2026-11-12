// smaltnb build and built notebooks' factories (DESIGN.md decision 14). Runs against the built package (dist/,
// dist/cli/), with smaltdb's in-process engine, smaltql and smaltdf (pinned in packed.json: `npm run deps`). Builds into
// .cache/ inside the repository, so the built modules find smaltnb and smaltkit as an app's would.
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { smaltty as ts } from 'smaltkit/typescript';
import { Database, registerLanguage } from 'smaltdb/engine';
import { sqlLanguage } from 'smaltql';
import * as df from '@smaltdb/df';
import { collectedTable } from 'smaltnb';
import { createRuntime } from 'smaltnb/runtime';
import { isNotebookFactory, type NotebookFactory } from 'smaltnb/library';
// @ts-expect-error: the command has no declarations
import { main } from '../dist/cli/smaltnb.js';

registerLanguage(sqlLanguage);
registerLanguage(df.dfLanguage);

const repo = fileURLToPath(new URL('..', import.meta.url));
const out = `${repo}.cache/test-build`;
const examples = `${repo}examples`;

async function cli(...argv: string[]) {
  let o = '';
  let e = '';
  const code: number = await main(argv, { out: (s: string) => void (o += s), err: (s: string) => void (e += s) });
  return { code, out: o, err: e };
}

function shop() {
  const db = Database.openMemory();
  db.exec(readFileSync(`${examples}/shop.sql`, 'utf8'));
  return db;
}

const count = (db: ReturnType<typeof shop>, value: unknown) =>
  db.query(`SELECT count(*) FROM temp."${collectedTable(value)!.table}"`).rows[0]![0];

before(async () => {
  rmSync(out, { recursive: true, force: true });
  const r = await cli('build', `${examples}/orders.nb.ts`, `${examples}/report.nb.ts`, '--out', out);
  assert.equal(r.code, 0, r.err);
});

const load = async (name: string) => (await import(pathToFileURL(`${out}/${name}`).href)).default as NotebookFactory<Record<string, unknown>>;

test('smaltnb build writes a .nb.js and a .nb.d.ts per notebook; the types come from the source', async () => {
  const dts = readFileSync(`${out}/orders.nb.d.ts`, 'utf8');
  assert.match(dts, /import type \* as source from "\.\.\/\.\.\/examples\/orders\.nb\.ts";/);
  assert.match(dts, /declare const notebook: NotebookFactory<typeof source>;/);
  assert.match(readFileSync(`${out}/report.nb.js`, 'utf8'), /"orders\.nb\.ts": \(\) => import\("\.\/orders\.nb\.js"\)/);
  assert.ok(isNotebookFactory(await load('orders.nb.js')));
});

test('with(params).get(...names) runs what those exports need, with those parameters; never an action', async () => {
  const db = shop();
  const orders = (await load('orders.nb.js')).in({ database: db, frame: df.table });
  const all = await orders.get('orders');
  const big = await orders.with({ minQty: 3 }).get('orders', 'params');
  assert.equal(count(db, all.orders), 7);
  assert.equal(count(db, big.orders), 3);
  assert.deepEqual(big.params, { minQty: 3 });
  assert.equal(orders.with({ minQty: 3 }), orders.with({ minQty: 3 }), 'the same parameters give the same instance');
  assert.equal(db.query('SELECT count(*) FROM orders WHERE qty = 0').rows[0]![0], 1, 'the action did not run');
  await assert.rejects(orders.with({ minQty: 'lots' as never }).get('orders'), /orders\.nb\.ts: cell "params" failed: Parameter "minQty": "lots" is not a number/);
  await assert.rejects(orders.get('nope' as never), /orders\.nb\.ts doesn't export "nope"/);
});

test('a built notebook that imports another gets it from that one\'s built module', async () => {
  const db = shop();
  const report = await load('report.nb.js');
  const { byRegion } = await report.with({}, { database: db, frame: df.table }).get('byRegion');
  assert.deepEqual(db.query(`SELECT region FROM temp."${collectedTable(byRegion)!.table}"`).rows.map((r) => r[0]), ['west', 'east', 'south', 'north']);
});

test('a notebook that imports a built notebook\'s factory runs it on its own database', async () => {
  const db = shop();
  const source = `import { cell, sql } from 'smaltnb';
import orders from './built/orders.nb.js';
cell('big');
const { orders: rows } = await orders.with({ minQty: 2 }).get('orders');
export const n = sql\`SELECT count(*) AS n FROM \${rows}\`;
n;
`;
  const rt = createRuntime(source, {
    ts, fileName: 'main.nb.ts', database: db, frame: df.table,
    importModule: async (spec) => (spec === './built/orders.nb.js' ? import(pathToFileURL(`${out}/orders.nb.js`).href) : df),
  });
  await rt.runAll();
  assert.equal(rt.state('big')!.status, 'ok', rt.state('big')!.reason ?? '');
  assert.deepEqual(rt.state('big')!.outputTable!.preview.rows, [[5]]);
});

test('smaltnb build refuses a notebook with errors, or one whose imported notebook isn\'t built with it', async () => {
  const dir = `${repo}.cache/test-build-bad`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/bad.nb.ts`, `import { cell } from 'smaltnb';\ncell('a'); export const x = y;\ncell('b'); export const y = 1;\n`);
  const bad = await cli('build', `${dir}/bad.nb.ts`, '--out', `${dir}/out`);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /smaltnb build: bad\.nb\.ts \(a\): .*"y"/);
  const alone = await cli('build', `${examples}/report.nb.ts`, '--out', `${dir}/out`);
  assert.equal(alone.code, 1);
  assert.match(alone.err, /report\.nb\.ts imports orders\.nb\.ts: build it in the same command/);
  assert.equal((await cli('build')).code, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('the built types check an app\'s calls: parameter values, export names', () => {
  writeFileSync(`${out}/app.ts`, `import orders from './orders.nb.js';
const { orders: frame, params } = await orders.with({ minQty: 2 }).get('orders', 'params');
const q: number = params.minQty;
// @ts-expect-error: minQty is a number
orders.with({ minQty: 'two' });
// @ts-expect-error: the notebook has no such parameter
orders.with({ maxQty: 2 });
// @ts-expect-error: the notebook has no such export
orders.get('nope');
export { frame, q };
`);
  writeFileSync(`${out}/tsconfig.json`, JSON.stringify({
    compilerOptions: { module: 'esnext', target: 'es2022', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, types: [] },
    files: ['app.ts'],
  }));
  execFileSync(process.execPath, [`${repo}node_modules/typescript7/bin/tsc`, '-p', `${out}/tsconfig.json`], { stdio: 'pipe' });
});
