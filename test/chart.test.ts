// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smaltty } from 'smaltkit/typescript';
import { chart, Chart, CHART_ROWS } from 'smaltnb/chart';
import { createRuntime } from 'smaltnb/runtime';
import { view } from 'smaltnb/kernel';

const head = "import { cell, chart } from 'smaltnb';\n";

test('chart.* makes a Chart of its data and options; it needs x and y', () => {
  const rows = [{ region: 'north', revenue: 3 }];
  const c = chart.bar(rows, { x: 'region', y: 'revenue', labels: true });
  assert.ok(c instanceof Chart);
  assert.equal(c.kind, 'bar');
  assert.equal(c.data, rows);
  assert.deepEqual(c.columns(), ['region', 'revenue']);
  assert.deepEqual(chart.scatter(rows, { x: 'revenue', y: 'revenue', series: 'region' }).columns(), ['revenue', 'revenue', 'region']);
  assert.throws(() => chart.line(rows, {} as never), /chart\.line: give the columns to draw/);
});

test('without a database, a chart of an array of rows is the cell\'s output; the page gets its columns and rows', async () => {
  const rt = createRuntime(head + `cell('data'); export const data = [{ m: 'jan', a: 1, b: 2 }, { m: 'feb', a: 3, b: 1 }];
cell('plot'); chart.line(data, { x: 'm', y: ['a', 'b'], smooth: true });`, { ts: smaltty });
  await rt.runAll();
  const s = rt.state('plot')!;
  assert.equal(s.status, 'ok');
  assert.deepEqual(view(s).output, {
    kind: 'chart',
    chart: { kind: 'line', options: { x: 'm', y: ['a', 'b'], smooth: true }, columns: ['m', 'a', 'b'], rows: [['jan', 1, 2], ['feb', 3, 1]], rowCount: 2 },
  });
});

test(`a chart reads at most ${CHART_ROWS} rows, and says how many there are`, async () => {
  const rt = createRuntime(head + `cell('plot'); chart.scatter(Array.from({ length: ${CHART_ROWS + 10} }, (_, i) => ({ i, v: i * 2 })), { x: 'i', y: 'v' });`, { ts: smaltty });
  await rt.runAll();
  const out = rt.state('plot')!.outputChart!;
  assert.equal(out.rows.length, CHART_ROWS);
  assert.equal(out.rowCount, CHART_ROWS + 10);
});

test('a chart that names a column its data lacks, or of data that isn\'t rows, is an error on its cell', async () => {
  const rt = createRuntime(head + `cell('a'); chart.bar([{ x: 1 }], { x: 'x', y: 'y' });
cell('b'); chart.bar(42, { x: 'x', y: 'y' });`, { ts: smaltty });
  await rt.runAll();
  assert.match(rt.state('a')!.error!.message, /no column "y" in the data \(it has "x"\)/);
  assert.match(rt.state('b')!.error!.message, /its data must be a query, a frame, another cell's result or an array of rows/);
});
