// Row types for SQL results (DESIGN.md decision 11). Runs against the built package (dist/), with smaltdb's in-process
// engine and smaltql (pinned in packed.json: `npm run deps`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smaltty as ts } from 'smaltkit/typescript';
import { Database, registerLanguage } from 'smaltdb/engine';
import { sqlLanguage } from 'smaltql';
import { checkRowType, rowTypeOf, tsTypeOf } from 'smaltnb/rowtype';
import { createRuntime } from 'smaltnb/runtime';
import { view } from 'smaltnb/kernel';

registerLanguage(sqlLanguage);

test('the engine\'s column types as TypeScript, and a row type from a result\'s columns', () => {
  assert.deepEqual(['int', 'real', 'num', 'text', 'bool', 'blob', 'null', 'any', undefined].map(tsTypeOf),
    ['number', 'number', 'number', 'string', 'boolean', 'Uint8Array', 'null', 'unknown', 'unknown']);
  assert.equal(rowTypeOf(['region', 'revenue'], ['text', 'real']), '{ region: string; revenue: number }');
  assert.equal(rowTypeOf(['order id', "it's"], ['int', 'text']), `{ 'order id': number; 'it\\'s': string }`);
  assert.equal(rowTypeOf([], []), '{}');
});

test('checkRowType: same names, and a type that takes the run\'s; named types aren\'t checked', () => {
  const cols = ['region', 'revenue', 'note'];
  const types = ['text', 'real', 'any'];
  assert.equal(checkRowType(ts, '{ region: string; revenue: number; note: unknown }', cols, types), null);
  assert.equal(checkRowType(ts, "{ 'region': string | null; revenue?: number | null; note: string }", cols, types), null, 'null added by hand, any column type');
  assert.equal(checkRowType(ts, '{ region: string; revenue: bigint; note: unknown }', cols, ['text', 'int', 'any']), null, 'an integer as bigint');
  assert.equal(checkRowType(ts, 'Order', cols, types), null);
  assert.equal(checkRowType(ts, '{ region: string; total: number }', cols, types),
    'the result has "revenue", "note", which the type doesn\'t; the type has "total", which the result doesn\'t.');
  assert.equal(checkRowType(ts, '{ region: number; revenue: number; note: unknown }', cols, types),
    '"region" is string in the result, number in the type.');
});

const head = "import { cell, sql } from 'smaltnb';\n";

test('a plain SQL query cell\'s state has its row type: inferred from the run, pinned, and whether they match', async () => {
  const db = Database.openMemory();
  db.exec("CREATE TABLE orders(region TEXT, qty INTEGER, price REAL); INSERT INTO orders VALUES ('north', 2, 1.5)");
  const src = head + `cell('open', { lang: 'sql' });
export const open = sql\`SELECT region, qty * price AS revenue FROM orders\`;
cell('pinned', { lang: 'sql' });
export const pinned = sql<{ region: string; revenue: number }>\`SELECT region, qty * price AS revenue FROM orders\`;
cell('stale', { lang: 'sql' });
export const stale = sql<{ region: string; total: number }>\`SELECT region, qty * price AS revenue FROM orders\`;
cell('ts');
export const tsCell = sql\`SELECT 1 AS one\`;
`;
  const rt = createRuntime(src, { ts, database: db });
  await rt.runAll();
  assert.deepEqual(rt.state('open')!.rowType, { inferred: '{ region: string; revenue: number }', pinned: null, mismatch: null });
  assert.deepEqual(rt.state('pinned')!.rowType, { inferred: '{ region: string; revenue: number }', pinned: '{ region: string; revenue: number }', mismatch: null });
  assert.match(rt.state('stale')!.rowType!.mismatch!, /the result has "revenue", which the type doesn't; the type has "total"/);
  assert.equal(rt.state('ts')!.rowType, null, 'only plain SQL cells: the page writes their type back');
  assert.deepEqual(view(rt.state('pinned')!).rowType, rt.state('pinned')!.rowType);
});
