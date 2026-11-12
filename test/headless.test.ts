// smaltnb run and the run report. Runs against the built package (dist/, dist/cli/), with smaltdb's in-process engine,
// smaltql and smaltdf (pinned in packed.json: `npm run deps`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smaltty as ts } from 'smaltkit/typescript';
import { Database, registerLanguage } from 'smaltdb/engine';
import { sqlLanguage } from 'smaltql';
import * as df from '@smaltdb/df';
import { reportJson, reportMarkdown, reportText, runNotebook } from 'smaltnb/report';
// @ts-expect-error: the command has no declarations; it is run, not imported, by users
import { main, parseArgs } from '../dist/cli/smaltnb.js';

registerLanguage(sqlLanguage);
registerLanguage(df.dfLanguage);

const shop = new URL('../examples/shop.nb.ts', import.meta.url).pathname;
const seed = new URL('../examples/shop.sql', import.meta.url).pathname;

/** Runs the command, capturing what it prints. */
async function run(...argv: string[]) {
  let out = '';
  let err = '';
  const code: number = await main(argv, { out: (s: string) => void (out += s), err: (s: string) => void (err += s) });
  return { code, out, err };
}

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smaltnb-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('runNotebook runs every cell but the actions, and reports each one: status, time, output', async () => {
  const db = Database.openMemory();
  db.exec(readFileSync(seed, 'utf8'));
  const r = await runNotebook(readFileSync(shop, 'utf8'), {
    ts, database: db, frame: df.table, importModule: async () => df, fileName: 'shop.nb.ts', params: { minQty: '2', nope: 'x' }, reportRows: 2,
  });
  assert.equal(r.ok, true);
  assert.equal(r.notebook, 'shop.nb.ts');
  assert.deepEqual(r.cells.map((c) => [c.id, c.status]), [
    ['setup', 'ok'], ['intro', 'ok'], ['params', 'ok'], ['orders', 'ok'], ['byRegion', 'ok'], ['revenueChart', 'ok'], ['bigOrders', 'ok'], ['save totals', 'idle'],
  ]);
  assert.deepEqual(r.params.map((p) => [p.name, p.value]), [['minQty', '2']]);
  assert.deepEqual(r.unknownParams, ['nope']);
  const byRegion = r.cells.find((c) => c.id === 'byRegion')!.output;
  assert.deepEqual(byRegion, { kind: 'table', columns: ['region', 'revenue'], rowCount: 4, rows: [['east', 1240], ['west', 1200]] });
  assert.deepEqual(r.cells.find((c) => c.id === 'revenueChart')!.output, { kind: 'chart', chart: 'bar', columns: ['region', 'revenue'], rowCount: 4 });
  assert.equal(r.cells.find((c) => c.id === 'intro')!.output.kind, 'markdown');
  assert.match(reportText(r), /· save totals \(action\)  not run: actions run with --actions/);
  assert.match(reportText(r), /param nope: the notebook declares no such parameter/);
});

test('a failing or held cell makes the run not ok; the reports say which and why', async () => {
  const db = Database.openMemory();
  const r = await runNotebook(`import { cell, sql, exec } from 'smaltnb';
cell('bad'); export const n: number = (null as any).x;
cell('write'); await exec\`CREATE TABLE t(a)\`;
cell('fine'); export const big = 2n ** 70n; big;
`, { ts, database: db, fileName: 'x.nb.ts' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.cells.map((c) => c.status), ['ok', 'error', 'held', 'ok']);
  assert.match(reportText(r), /✗ bad  error · Cannot read properties of null/);
  assert.match(reportText(r), /failed: 2 problems/);
  assert.match(reportJson(r), /"value": "1180591620717411303424"/, 'a bigint too large for a number is text in the JSON');
  const md = reportMarkdown(r);
  assert.match(md, /^## x\.nb\.ts: failed/);
  assert.match(md, /\| ! \| write \| held: /);
});

test('smaltnb run: the shop example, seeded with SQL, exits 0 and prints each cell', withDir(async (dir) => {
  const report = join(dir, 'run.json');
  const md = join(dir, 'run.md');
  const r = await run('run', shop, '--init', seed, '--actions', '--param', 'minQty=2', '--report', report, '--md', md);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^shop\.nb\.ts \(with actions\)\n  param minQty = 2 \(default 1\)\n/);
  assert.match(r.out, /✓ save totals \(action\)/);
  assert.match(r.out, /ok: 8 cells in/);
  const json = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(json.ok, true);
  assert.deepEqual(json.cells.find((c: { id: string }) => c.id === 'save totals').output, { kind: 'value', value: { rows: 4 } });
  assert.match(readFileSync(md, 'utf8'), /\| east \| 1240 \|/);
}));

test('smaltnb run: a parameter that doesn\'t fit fails its cell and exits 1; --quiet prints only the result', async () => {
  const r = await run('run', shop, '--init', seed, '--param', 'minQty=lots', '--quiet');
  assert.equal(r.code, 1);
  assert.match(r.out, /^failed: \d+ problems? in/);
  assert.doesNotMatch(r.out, /\n./);
});

test('smaltnb run: --md - appends to the GitHub Actions job summary', withDir(async (dir) => {
  const summary = join(dir, 'summary.md');
  writeFileSync(summary, 'before\n');
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    const r = await run('run', shop, '--init', seed, '--md', '-', '--quiet');
    assert.equal(r.code, 0, r.err);
  } finally {
    delete process.env.GITHUB_STEP_SUMMARY;
  }
  assert.match(readFileSync(summary, 'utf8'), /^before\n## shop\.nb\.ts: ok/);
}));

test('smaltnb run: usage errors exit 2 with the help; --help exits 0', async () => {
  assert.equal(parseArgs(['--help']), 'help');
  assert.deepEqual(parseArgs(['run', 'a.nb.ts', '--param', 'x=1=2', '--actions']).params, { x: '1=2' });
  for (const [argv, message] of [
    [['go', 'a.nb.ts'], /Unknown command "go"/],
    [['run'], /Give the notebook to run/],
    [['run', 'a.nb.ts', '--param', 'x'], /--param needs name=value/],
    [['run', 'a.nb.ts', '--frobnicate'], /Unknown option --frobnicate/],
    [['run', 'a.nb.ts', 'b.nb.ts'], /One notebook at a time/],
  ] as const) {
    const r = await run(...argv);
    assert.equal(r.code, 2, String(argv));
    assert.match(r.err, message);
    assert.match(r.err, /Usage: smaltnb run/);
  }
  assert.match((await run('run', '/nonexistent.nb.ts')).err, /Can't read \/nonexistent\.nb\.ts/);
  assert.equal((await run('--help')).code, 0);
});

test('smaltnb run --db without the file plugin says what to install, and exits 2', async () => {
  const r = await run('run', shop, '--db', join(tmpdir(), 'never.db'));
  assert.equal(r.code, 2);
  assert.match(r.err, /--db \(a database in a file\) needs @smaltworks\/smaltdb-node, which isn't installed/);
});
