// Cypher cells: smaltcy (pinned in packed.json) runs them on the notebook's graph, beside smaltdb's in-process engine
// with smaltql. Runs against the built package (dist/).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smaltty as ts } from 'smaltkit/typescript';
import { Database, registerLanguage } from 'smaltdb/engine';
import { sqlLanguage } from 'smaltql';
import * as smaltcy from '@smaltworks/smaltcy';
import { createRuntime, type RuntimeOptions } from 'smaltnb/runtime';
import { collectedTable, cypher, GraphResult, graphPlanWrites, parseNotebook, sqlBody } from 'smaltnb';
import { runNotebook } from 'smaltnb/report';

registerLanguage(sqlLanguage);

const graph = { open: () => smaltcy.open(), compile: smaltcy.compile };

function shop() {
  const db = Database.openMemory();
  db.exec(`CREATE TABLE people(name TEXT, city TEXT);
    INSERT INTO people VALUES ('Ada', 'London'), ('Alan', 'Wilmslow'), ('Grace', 'New York');
    CREATE TABLE knows(a TEXT, b TEXT); INSERT INTO knows VALUES ('Ada', 'Alan'), ('Alan', 'Grace')`);
  return db;
}

function runtime(source: string, options: Partial<RuntimeOptions> = {}) {
  return createRuntime(source, { ts, database: shop(), graph, ...options });
}
const status = (rt: ReturnType<typeof runtime>) => Object.fromEntries(rt.states().map((s) => [s.id, s.status]));

const header = `import { cell, action, sql, cypher } from 'smaltnb';\n`;

const notebook = header + `
cell('people', { lang: 'sql' });
export const people = sql\`SELECT name, city FROM people ORDER BY name\`;
cell('knows', { lang: 'sql' });
export const knows = sql\`SELECT a, b FROM knows\`;
action('load', { lang: 'cypher' });
await cypher.run\`UNWIND \${people} AS p CREATE (:Person {name: p.name, city: p.city})\`;
await cypher.run\`UNWIND \${knows} AS k MATCH (a:Person {name: k.a}), (b:Person {name: k.b}) CREATE (a)-[:KNOWS]->(b)\`;
cell('chain', { lang: 'cypher' });
export const chain = cypher\`MATCH p = (a:Person {name: 'Ada'})-[:KNOWS*]->(b) RETURN b.name AS name, length(p) AS hops ORDER BY hops\`;
chain;
cell('friends', { lang: 'cypher' });
export const friends = cypher\`MATCH (a:Person)-[k:KNOWS]->(b:Person) RETURN a, k, b\`;
friends;
cell('cities', { lang: 'sql' });
export const cities = sql\`SELECT name, hops FROM \${chain} ORDER BY hops\`;
cities;
`;

test('a graph built from SQL results in an action; Cypher results read back by SQL and drawn as a graph', async () => {
  const rt = runtime(notebook);
  await rt.runAll();
  // The action hasn't run: the graph is empty, so the queries find nothing.
  assert.equal(rt.state('load')!.status, 'idle');
  assert.equal((rt.value('chain') as GraphResult).rowCount, 0);
  await rt.run(['load']);
  await rt.run(['chain', 'friends', 'cities']);
  assert.deepEqual(status(rt), { setup: 'ok', people: 'ok', knows: 'ok', load: 'ok', chain: 'ok', friends: 'ok', cities: 'ok' });

  const chain = rt.value('chain') as GraphResult;
  assert.ok(chain instanceof GraphResult);
  assert.deepEqual(chain.rows, [{ name: 'Alan', hops: 1 }, { name: 'Grace', hops: 2 }]);
  assert.deepEqual(collectedTable(chain), { table: 'nb_chain_chain', columns: ['name', 'hops'], columnTypes: ['any', 'any'], rowCount: 2 });
  assert.deepEqual(rt.state('cities')!.outputTable!.preview.rows, [['Alan', 1], ['Grace', 2]]);

  // Nodes and relationships: drawn by the page, stored as JSON for SQL.
  const out = rt.state('friends')!;
  assert.equal(out.outputGraph!.nodes.length, 3);
  assert.equal(out.outputGraph!.relationships.length, 2);
  assert.deepEqual(out.outputGraph!.nodes.map((n) => n.properties.name).sort(), ['Ada', 'Alan', 'Grace']);
  const firstA = JSON.parse(out.outputTable!.preview.rows[0]![0] as string);
  assert.equal(firstA.kind, 'node');
  assert.deepEqual(firstA.labels, ['Person']);
  assert.equal(rt.state('chain')!.outputGraph, null, 'rows of plain values have no graph');

  // What completion knows.
  assert.deepEqual(rt.graphVocabulary(), { labels: ['Person'], types: ['KNOWS'], properties: ['city', 'name'] });
});

test("a Cypher write in a cell that isn't an action is held, and runs when the cell is run", async () => {
  const rt = runtime(header + `
cell('add', { lang: 'cypher' });
export const add = cypher\`CREATE (n:Note {text: 'hi'}) RETURN n.text AS text\`;
`);
  await rt.runAll();
  assert.equal(rt.state('add')!.status, 'held');
  assert.match(rt.state('add')!.reason!, /This Cypher statement writes to the notebook's graph/);
  await rt.run(['add']);
  assert.equal(rt.state('add')!.status, 'ok');
  assert.deepEqual((rt.value('add') as GraphResult).writes, { nodesCreated: 1, propertiesSet: 1, labelsAdded: 1 });
});

test('parameters: values, lists and maps; nodes become their properties; other objects are refused', async () => {
  const rt = runtime(header + `
cell('a', { lang: 'cypher' });
export const a = cypher\`RETURN \${2} * 3 AS six, \${['x', 'y']} AS list, \${{ k: 1 }}.k AS key\`;
cell('b');
const when = new Date(0);
export const b = cypher\`RETURN \${when} AS iso\`;
cell('c');
export const c = cypher\`RETURN \${new Map()} AS bad\`;
`);
  await rt.runAll();
  assert.deepEqual((rt.value('a') as GraphResult).rows, [{ six: 6, list: ['x', 'y'], key: 1 }]);
  assert.deepEqual((rt.value('b') as GraphResult).rows, [{ iso: '1970-01-01T00:00:00.000Z' }]);
  assert.equal(rt.state('c')!.status, 'error');
  assert.match(rt.state('c')!.reason!, /\$\{\} number 1 is Map/);
});

test("a Cypher syntax error is the cell's error; without smaltcy, Cypher says what it needs", async () => {
  const rt = runtime(header + `cell('bad', { lang: 'cypher' });\nexport const bad = cypher\`MATCH (n RETURN n\`;\n`);
  await rt.runAll();
  assert.equal(rt.state('bad')!.status, 'error');
  assert.match(rt.state('bad')!.reason!, /^Cypher: /);
  const none = createRuntime(header + `cell('q');\nexport const q = cypher\`RETURN 1 AS one\`;\n`, { ts, database: shop() });
  await none.runAll();
  assert.match(none.state('q')!.reason!, /Cypher needs smaltcy/);
});

test('graphPlanWrites tells writes by the plan; cypher builds $p parameters and keeps the text raw', () => {
  assert.equal(graphPlanWrites(smaltcy.compile('MATCH (n) RETURN n').plan), false);
  for (const w of ["CREATE (:A)", "MATCH (n) SET n.x = 1", "MATCH (n) DETACH DELETE n", "MERGE (:A {k: 1})", "MATCH (n) REMOVE n:A", "CREATE INDEX ON :A(k)"]) {
    assert.equal(graphPlanWrites(smaltcy.compile(w).plan), true, w);
  }
  const q = cypher`MATCH (n {name: ${'Ada'}}) WHERE n.x =~ 'a\.b' RETURN n LIMIT ${3}`;
  assert.equal(q.text, "MATCH (n {name: $p1}) WHERE n.x =~ 'a\\.b' RETURN n LIMIT $p2");
  assert.deepEqual(q.values, ['Ada', 3]);
});

test("plain Cypher cells: a query named after its cell, and an action of cypher.run statements; anything more isn't plain", () => {
  const src = header + `
cell('q', { lang: 'cypher' });
export const q = cypher\`MATCH (n) RETURN n\`;
q;
action('w', { lang: 'cypher' });
await cypher.run\`CREATE (:A)\`;
await cypher.run\`CREATE (:B)\`;
cell('typed', { lang: 'cypher' });
const typed = cypher\`RETURN 1\`; // a comment keeps it TypeScript
`;
  const nb = parseNotebook(src, ts);
  const q = nb.cells.find((c) => c.id === 'q')!;
  assert.deepEqual(q.sql, { kind: 'cypher', name: 'q', exported: true, text: 'MATCH (n) RETURN n', output: true });
  assert.equal(sqlBody(q.sql!), 'export const q = cypher`MATCH (n) RETURN n`;\nq;');
  const w = nb.cells.find((c) => c.id === 'w')!;
  assert.deepEqual(w.sql, { kind: 'cypher-script', statements: ['CREATE (:A)', 'CREATE (:B)'] });
  assert.equal(sqlBody(w.sql!), 'await cypher.run`CREATE (:A)`;\nawait cypher.run`CREATE (:B)`;');
  assert.equal(nb.cells.find((c) => c.id === 'typed')!.sql, null);
  assert.deepEqual(nb.diagnostics, []);
});

test('an imported notebook queries its importer\'s graph: one graph per notebook, not per import', async () => {
  const lib = header + `
cell('names', { lang: 'cypher' });
export const names = cypher\`MATCH (p:Person) RETURN p.name AS name ORDER BY name\`;
`;
  let opened = 0;
  const counting = { open: () => { opened++; return smaltcy.open(); }, compile: smaltcy.compile };
  const rt = runtime(`import { cell, cypher } from 'smaltnb';
import { names } from './lib.nb.ts';
cell('both', { lang: 'cypher' });
export const both = cypher\`MATCH (p:Person) RETURN count(p) AS n\`;
cell('imported');
export const imported = names;
`, { readNotebook: async () => lib, fileName: 'main.nb.ts', graph: counting });
  await rt.runAll();
  assert.deepEqual(status(rt), { setup: 'ok', both: 'ok', imported: 'ok' });
  assert.equal(opened, 1);
});

test('a headless run runs Cypher cells, and their actions with --actions', async () => {
  const report = await runNotebook(notebook, { ts, database: shop(), graph, actions: true });
  const cells = Object.fromEntries(report.cells.map((c) => [c.id, c.status]));
  assert.equal(cells.load, 'ok');
  assert.equal(cells.chain, 'ok');
});

test('examples/network.nb.ts: an action builds the graph from a table; Cypher and SQL read it; the kernel sends the graph', async () => {
  const { readFileSync } = await import('node:fs');
  const { MessageChannel } = await import('node:worker_threads');
  const { serveKernel } = await import('smaltnb/kernel');
  const { KernelClient } = await import('smaltnb/client');
  const source = readFileSync(new URL('../examples/network.nb.ts', import.meta.url), 'utf8');
  const shopSql = readFileSync(new URL('../examples/shop.sql', import.meta.url), 'utf8');
  const open = () => { const db = Database.openMemory(); db.exec(shopSql); return db; };
  const { port1, port2 } = new MessageChannel();
  serveKernel(port2 as never, { ts, database: open, graph });
  const k = new KernelClient(() => ({
    postMessage: (m) => port1.postMessage(m),
    addEventListener: (_t, l) => port1.addEventListener('message', (e) => l({ data: (e as MessageEvent).data })),
    terminate: () => { port1.close(); port2.close(); },
  }));
  try {
    await k.open(source, 'network.nb.ts');
    await k.runAll();
    await k.run(['Build the graph']);
    await k.run(['placed', 'byRegion', 'top']);
    for (const id of ['orders', 'Build the graph', 'placed', 'byRegion', 'top']) assert.equal(k.state(id)!.status, 'ok', `${id}: ${k.state(id)!.reason}`);
    const placed = k.state('placed')!.output;
    assert.equal(placed.kind, 'table');
    if (placed.kind === 'table') {
      assert.equal(placed.graph!.nodes.length, 4 + 7, 'four regions and the seven orders with a quantity');
      assert.equal(placed.graph!.relationships.length, 7);
    }
    const top = k.state('top')!.output;
    assert.ok(top.kind === 'table' && top.preview.rows.map((r) => r[0]).join() === 'west,east');
  } finally {
    k.close();
  }
});

test("the kernel sends the graph's vocabulary when it changes, and a new notebook starts without one", async () => {
  const { MessageChannel } = await import('node:worker_threads');
  const { serveKernel } = await import('smaltnb/kernel');
  const { KernelClient } = await import('smaltnb/client');
  const { port1, port2 } = new MessageChannel();
  serveKernel(port2 as never, { ts, database: () => Database.openMemory(), graph });
  const seen: unknown[] = [];
  const k = new KernelClient(() => ({
    postMessage: (m) => port1.postMessage(m),
    addEventListener: (_t, l) => port1.addEventListener('message', (e) => l({ data: (e as MessageEvent).data })),
    terminate: () => { port1.close(); port2.close(); },
  }), { onGraph: (v) => seen.push(v) });
  try {
    await k.open(header + `action('add');\nawait cypher.run\`CREATE (:City {name: 'Oslo'})-[:NEAR]->(:City {name: 'Bergen'})\`;\n`);
    await k.runAll();
    assert.equal(k.graph, null, 'nothing has used Cypher yet');
    await k.run(['add']);
    assert.deepEqual(k.graph, { labels: ['City'], types: ['NEAR'], properties: ['name'] });
    await k.run(['add']);
    assert.equal(seen.length, 1, 'sent again only when it changes');
    await k.open(header + `cell('none');\nexport const none = 1;\n`);
    assert.equal(k.graph, null);
  } finally {
    k.close();
  }
});
