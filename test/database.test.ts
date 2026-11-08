// Runs against the built package (dist/), with smaltdb's in-process engine, smaltql and smaltdf (pinned in
// packed.json: `npm run deps`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { smaltty as ts } from 'smaltkit/typescript';
import { Database, registerLanguage } from 'smaltdb/engine';
import { sqlLanguage } from 'smaltql';
import { dfLanguage, table } from '@smaltdb/df';
import * as df from '@smaltdb/df';
import { createRuntime, type RuntimeOptions } from 'smaltnb/runtime';
import { collectedTable, planWrites, Relation, sql } from 'smaltnb';
import { KernelClient } from 'smaltnb/client';
import { serveKernel } from 'smaltnb/kernel';

registerLanguage(sqlLanguage);
registerLanguage(dfLanguage);

function shop() {
  const db = Database.openMemory();
  db.exec(`CREATE TABLE orders(id INTEGER, region TEXT, qty INTEGER, price REAL);
    INSERT INTO orders VALUES (1, 'north', 3, 18.5), (2, 'east', 0, 42), (3, 'south', 1, 7.25), (4, 'north', 2, 12)`);
  return db;
}

const header = `import { cell, action, sql, exec, db } from 'smaltnb';
import { col, frame } from '@smaltdb/df';
`;
const notebook = header + `
cell('params'); export const minQty = 1;
cell('raw', { lang: 'sql' });
export const raw = sql\`SELECT id, region, qty, price FROM orders WHERE qty >= \${minQty} ORDER BY id\`;
raw;
cell('clean', { lang: 'df' });
export const clean = raw.withColumns(col('qty').mul(col('price')).alias('revenue'));
cell('byRegion', { lang: 'sql' });
export const byRegion = sql\`SELECT region, sum(revenue) AS revenue FROM \${clean} GROUP BY region ORDER BY revenue DESC\`;
byRegion;
`;

function runtime(source: string, options: Partial<RuntimeOptions> = {}) {
  const db = shop();
  const rt = createRuntime(source, {
    ts, database: db, frame: table, importModule: async (spec) => (spec === '@smaltdb/df' ? df : {}), ...options,
  });
  return { rt, db };
}
const status = (rt: ReturnType<typeof runtime>['rt']) => Object.fromEntries(rt.states().map((s) => [s.id, s.status]));

test('a SQL cell is collected; smaltdf chains on it; SQL reads the frame back through ${}', async () => {
  const { rt, db } = runtime(notebook);
  await rt.runAll();
  assert.deepEqual(status(rt), { setup: 'ok', params: 'ok', raw: 'ok', clean: 'ok', byRegion: 'ok' });
  assert.deepEqual(collectedTable(rt.value('raw')), {
    table: 'nb_raw_raw', columns: ['id', 'region', 'qty', 'price'], columnTypes: ['int', 'text', 'int', 'real'], rowCount: 3,
  });
  assert.equal(collectedTable(rt.value('clean'))!.table, 'nb_clean_clean');
  const out = rt.state('byRegion')!.outputTable!;
  assert.deepEqual(out.preview.rows, [['north', 79.5], ['south', 7.25]]);
  assert.equal(out.rowCount, 2);
  assert.equal(db.query('SELECT count(*) FROM temp.nb_clean_clean').rows[0]![0], 3, 'the frame was collected in the engine');
});

test('rows gives a window of a collected output, for a grid that scrolls', async () => {
  const { rt } = runtime(notebook);
  await rt.runAll();
  assert.deepEqual((await rt.rows('raw', 1, 1)).rows, [[3, 'south', 1, 7.25]]);
  assert.deepEqual((await rt.rows('clean', 0, 1, 'clean')).columns, ['id', 'region', 'qty', 'price', 'revenue']);
  await assert.rejects(rt.rows('params', 0, 1), /no collected output/);
});

test('an edit re-collects: the new rows replace the old table', async () => {
  const { rt } = runtime(notebook);
  await rt.runAll();
  await rt.update(rt.source.replace('export const minQty = 1;', 'export const minQty = 2;'));
  assert.equal(rt.state('byRegion')!.status, 'ok');
  assert.deepEqual(rt.state('byRegion')!.outputTable!.preview.rows, [['north', 79.5]]);
});

test('renaming a result drops its old table', async () => {
  const { rt, db } = runtime(notebook);
  await rt.runAll();
  await rt.update(rt.source.replace(/\bbyRegion\b(?=;|\s=)/g, 'totals'));
  const temps = db.query(`SELECT name FROM temp.sqlite_schema WHERE type = 'table' ORDER BY name`).rows.map((r) => r[0]);
  assert.ok(temps.includes('nb_byRegion_totals'));
  assert.ok(!temps.includes('nb_byRegion_byRegion'));
});

test('without a frame function, a collected result is a Relation', async () => {
  const { rt } = runtime(header + `cell('a'); export const a = sql\`SELECT 1 AS one\`;`, { frame: undefined });
  await rt.runAll();
  assert.ok(rt.value('a') instanceof Relation);
  assert.equal((rt.value('a') as Relation).rowCount, 1);
});

test('a write in a reactive cell is held; running the cell lets it write', async () => {
  const { rt, db } = runtime(header + `cell('add'); await exec\`INSERT INTO orders VALUES (9, 'west', 1, 1)\`;`);
  await rt.runAll();
  assert.equal(rt.state('add')!.status, 'held');
  assert.match(rt.state('add')!.reason!, /writes to the database\. Run the cell to let it write, or mark it as an action/);
  assert.equal(db.query('SELECT count(*) FROM orders').rows[0]![0], 4, 'nothing was written');

  await rt.run(['add']);
  assert.equal(rt.state('add')!.status, 'ok');
  assert.equal(db.query('SELECT count(*) FROM orders').rows[0]![0], 5);
});

test('a smaltdf write is held the same way: side effects are defined by plan kind, not language', async () => {
  const { rt, db } = runtime(header + `cell('add'); await frame({ id: [9], region: ['west'], qty: [1], price: [1] }).insertInto(db, 'orders');`);
  await rt.runAll();
  assert.equal(rt.state('add')!.status, 'held');
  assert.equal(db.query('SELECT count(*) FROM orders').rows[0]![0], 4);
});

test('a TEMP table is a write too; queries through db are not', async () => {
  const { rt } = runtime(header + `cell('t'); await exec\`CREATE TEMP TABLE scratch(x)\`;
cell('q'); const n = (await db.query('SELECT count(*) AS n FROM orders')).rows[0]![0];`);
  await rt.runAll();
  assert.equal(rt.state('t')!.status, 'held');
  assert.equal(rt.state('q')!.status, 'ok');
  assert.equal(rt.value('n'), 4);
});

test('an action writes when it runs, on request or in a headless run', async () => {
  const src = header + `cell('total'); export const before = (await db.query('SELECT count(*) FROM orders')).rows[0]![0];
action('add'); const r = await exec\`INSERT INTO orders VALUES (\${Number(before) + 10}, 'west', 1, 1)\`;`;
  const { rt, db } = runtime(src);
  await rt.runAll();
  assert.equal(rt.state('add')!.status, 'idle', 'runAll leaves actions alone');
  await rt.runAll({ actions: true });
  assert.equal(rt.state('add')!.status, 'ok');
  assert.deepEqual(rt.value('r'), { rows: 1 });
  assert.equal(db.query('SELECT max(id) FROM orders').rows[0]![0], 14);
});

test('a live cell is not collected, and SQL refuses it with a reason', async () => {
  const { rt } = runtime(header + `import { table } from '@smaltdb/df';
cell('f', { live: true }); export const f = table('orders');
cell('g'); export const g = sql\`SELECT * FROM \${f}\`;`.replace("import { col, frame } from '@smaltdb/df';\n", ''));
  await rt.runAll();
  assert.equal(rt.state('f')!.status, 'ok');
  assert.equal(collectedTable(rt.value('f')), undefined);
  assert.equal(rt.state('g')!.status, 'error');
  assert.match(rt.state('g')!.reason!, /Only results that were collected \(not live\) can be read from SQL/);
});

test('queries with WITH and VALUES collect too', async () => {
  const { rt } = runtime(header + `cell('w'); export const w = sql\`WITH t AS (SELECT 2 AS x) SELECT x * 2 AS y FROM t\`;
cell('v'); export const v = sql\`VALUES (1, 'a'), (2, 'b')\`;`);
  await rt.runAll();
  assert.equal(rt.state('w')!.status, 'ok', rt.state('w')!.reason ?? '');
  assert.equal(rt.state('v')!.status, 'ok', rt.state('v')!.reason ?? '');
  assert.equal(collectedTable(rt.value('v'))!.rowCount, 2);
});

test('without a database, SQL cells say so', async () => {
  const rt = createRuntime(header + `cell('a'); export const a = sql\`SELECT 1\`;`, {
    ts, importModule: async () => df,
  });
  await rt.runAll();
  assert.match(rt.state('a')!.reason!, /no database/);
});

test('sql builds parameters and identifiers, never splicing values into the text', () => {
  const q = sql`SELECT * FROM ${sql.id('my "table"')} WHERE a = ${"x'; DROP TABLE t; --"} AND b IN (${1}, ${2n})`;
  assert.equal(q.text, 'SELECT * FROM "my ""table""" WHERE a = ?1 AND b IN (?2, ?3)');
  assert.deepEqual(q.params, ["x'; DROP TABLE t; --", 1, 2n]);
  assert.throws(() => sql`SELECT ${undefined}`, /is undefined/);
  assert.throws(() => sql`SELECT ${{ a: 1 }}`, /not a collected result or a value/);
});

test('planWrites: only queries, EXPLAIN, bare operations and transaction control are reads', () => {
  assert.equal(planWrites({ kind: 'query', plan: {} }), false);
  assert.equal(planWrites({ op: 'scan' }), false);
  assert.equal(planWrites({ kind: 'explain', mode: 'plan', query: {} }), false);
  assert.equal(planWrites({ kind: 'transaction', action: 'begin' }), false);
  assert.equal(planWrites({ kind: 'write', plan: {} }), true);
  assert.equal(planWrites({ kind: 'schema' }), true);
  assert.equal(planWrites({ kind: 'maintenance', action: 'refresh' }), true);
});

test('through the kernel: a collected output arrives as a table, and the page fetches more rows', async () => {
  const { port1, port2 } = new MessageChannel();
  serveKernel(port2 as never, { ts, database: shop, frame: table, importModule: async () => df });
  const k = new KernelClient(() => ({
    postMessage: (m) => port1.postMessage(m),
    addEventListener: (_t, l) => port1.addEventListener('message', (e) => l({ data: (e as MessageEvent).data })),
    terminate: () => { port1.close(); port2.close(); },
  }));
  try {
    await k.open(notebook);
    await k.runAll();
    const out = k.state('raw')!.output;
    assert.equal(out.kind, 'table');
    if (out.kind === 'table') {
      assert.equal(out.table.rowCount, 3);
      assert.deepEqual(out.preview.columns, ['id', 'region', 'qty', 'price']);
    }
    assert.deepEqual((await k.rows('raw', 2, 10)).rows, [[4, 'north', 2, 12]]);
  } finally {
    k.close();
  }
});

test('examples/shop.nb.ts runs: smaltdf, then SQL over the collected frame, then the action saves it', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../examples/shop.nb.ts', import.meta.url), 'utf8');
  const { rt, db } = runtime(source);
  db.exec('CREATE TABLE region_totals(region TEXT, revenue REAL)');
  await rt.runAll();
  assert.deepEqual(status(rt), { setup: 'ok', intro: 'ok', params: 'ok', orders: 'ok', byRegion: 'ok', 'save totals': 'idle' });
  assert.deepEqual(rt.state('byRegion')!.outputTable!.preview.rows, [['north', 79.5], ['south', 7.25]]);
  await rt.run(['save totals']);
  assert.equal(rt.state('save totals')!.status, 'ok');
  assert.deepEqual(db.query('SELECT * FROM region_totals').rows, [['north', 79.5], ['south', 7.25]]);
});

test('with the worker client, whose array rows come back as the array itself, queries and rows still work', async () => {
  // A stand-in for smaltdb's client Database: async, no queryPlanAsync, and 'array' results that are arrays.
  const engine = shop();
  const client = {
    catalog: () => engine.catalog,
    async query(text: string, params: unknown[] = []) {
      const r = engine.query(text, params as never);
      return Object.assign(r.rows.map((row) => [...row]), { columns: r.columns, columnTypes: r.columnTypes ?? [] });
    },
    async exec(text: string, params: unknown[] = []) {
      if (engine.isScript(text)) { engine.exec(text, params as never); return { changes: 0, lastInsertRowid: 0 }; }
      return engine.run(text, params as never);
    },
    async prepare(text: string) {
      const st = engine.prepare(text);
      return { columns: st.columns, columnTypes: st.columnTypes, readonly: st.readonly, finalize: async () => {} };
    },
    async preparePlan(plan: unknown) {
      const st = engine.preparePlan(plan as never);
      return { columns: st.columns, columnTypes: st.columnTypes, finalize: async () => {} };
    },
    queryPlan: (stmt: unknown, params?: unknown, options?: unknown) => engine.queryPlanAsync(stmt as never, params as never, options as never),
  };
  const rt = createRuntime(header + `cell('raw'); export const raw = sql\`SELECT id, region FROM orders ORDER BY id\`;
raw;
cell('n'); export const n = (await db.query('SELECT count(*) FROM orders')).rows[0]![0];`, {
    ts, database: client, importModule: async () => df,
  });
  await rt.runAll();
  assert.equal(rt.state('raw')!.status, 'ok', rt.state('raw')!.reason ?? '');
  assert.deepEqual(rt.state('raw')!.outputTable!.preview.rows[0], [1, 'north']);
  assert.equal(rt.value('n'), 4);
  assert.deepEqual((await rt.rows('raw', 3, 5)).rows, [[4, 'north']]);
});

test('sql takes the template text as written: backslashes belong to SQL; only escaped backticks and ${ are unescaped', () => {
  const q = sql`SELECT * FROM t WHERE a LIKE 'x\_%' AND b = '\`' AND c = '\${n}' AND d = ${1}`;
  assert.equal(q.text, "SELECT * FROM t WHERE a LIKE 'x\\_%' AND b = '`' AND c = '${n}' AND d = ?1");
});
