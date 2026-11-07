// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { parseNotebook } from 'smaltnb/format';
import { buildGraph, downstream, exportClosure, propagate, upstream, type Graph } from 'smaltnb/graph';
import * as nb from 'smaltnb';

const graphOf = (source: string): Graph => buildGraph(parseNotebook(source, ts));
const example = graphOf(readFileSync(new URL('../examples/regional.nb.ts', import.meta.url), 'utf8'));

test('edges from names, and guard edges from when()', () => {
  const edges = example.edges.map((e) => `${e.from} -> ${e.to} [${e.kind}: ${e.names.join(',')}]`).sort();
  assert.deepEqual(edges, [
    'clean -> byRegion [value: clean]',
    'clean -> write clean [value: clean]',
    'params -> clean [value: params]',
    'params -> write clean [guard: params]',
    'raw -> clean [value: raw]',
  ]);
  assert.deepEqual(example.diagnostics, []);
});

test('type-only uses add no edge: types matter to the compiler, not to a run', () => {
  assert.ok(!example.edges.some((e) => e.from === 'types'));
});

test('run order is file order when the notebook reads top to bottom', () => {
  assert.deepEqual(example.order, ['setup', 'types', 'params', 'raw', 'clean', 'byRegion', 'write clean']);
});

test('upstream and downstream are transitive and in run order', () => {
  assert.deepEqual(upstream(example, ['byRegion']), ['params', 'raw', 'clean']);
  assert.deepEqual(downstream(example, ['raw']), ['clean', 'byRegion', 'write clean']);
  assert.deepEqual(downstream(example, ['byRegion']), []);
});

test('importing an export needs only its cells', () => {
  assert.deepEqual(exportClosure(example, ['raw']), { cells: ['raw'], missing: [] });
  assert.deepEqual(exportClosure(example, ['clean', 'nope']), { cells: ['params', 'raw', 'clean'], missing: ['nope'] });
});

test('a change reruns auto cells, and lazy cells and actions go stale, with everything after them', () => {
  // raw changes: clean is lazy, so it goes stale, and so do byRegion (auto, but its input is stale) and the action.
  assert.deepEqual(propagate(example, ['raw']), { run: ['raw'], stale: ['clean', 'byRegion', 'write clean'] });
  // Editing clean (lazy) leaves it stale until run, and everything after it waits.
  assert.deepEqual(propagate(example, ['clean']), { run: [], stale: ['clean', 'byRegion', 'write clean'] });
});

test('propagate: an action never runs on its own; manual cells wait', () => {
  const g = graphOf(`import { cell, action } from 'smaltnb';
cell('a'); const a = 1;
cell('b'); const b = a + 1;
cell('c', { run: 'manual' }); const c = b + 1;
cell('d'); const d = c + 1;
action('w'); console.log(b);`);
  assert.deepEqual(propagate(g, ['a']), { run: ['a', 'b'], stale: ['c', 'd', 'w'] });
});

test('a guard edge counts like a value edge for staleness', () => {
  const g = graphOf(`import { cell } from 'smaltnb';
cell('p'); const mode = 'full';
cell('x', { when: () => mode === 'full' }); const x = 1;`);
  assert.deepEqual(propagate(g, ['p']), { run: ['p', 'x'], stale: [] });
});

test('cycles through hoisted functions are reported', () => {
  const g = graphOf(`import { cell } from 'smaltnb';
cell('a'); const y = f();
cell('b'); function f(): number { return y; }`);
  assert.deepEqual(g.diagnostics.map((d) => d.code), ['cycle']);
  assert.deepEqual(g.order, ['setup', 'a', 'b']);
});

test('exports may not come from or depend on an action', () => {
  const g = graphOf(`import { cell, action } from 'smaltnb';
action('load'); export const loaded = 1;
cell('after'); export const twice = loaded * 2;`);
  assert.deepEqual(g.diagnostics.map((d) => d.code), ['export-from-action', 'export-needs-action']);
});

test('the package root exports the markers and the analysis', () => {
  assert.equal(typeof nb.cell, 'function');
  assert.equal(typeof nb.action, 'function');
  assert.equal(nb.cell('x'), undefined, 'markers do nothing at run time');
  assert.equal(typeof nb.parseNotebook, 'function');
  assert.equal(typeof nb.buildGraph, 'function');
});

test('propagate: cells run on request run whatever their mode, and count as run downstream', () => {
  // clean is lazy; asked to run, it runs, and byRegion (auto) runs after it. The action only goes stale.
  assert.deepEqual(propagate(example, [], { run: ['clean'] }), { run: ['clean', 'byRegion'], stale: ['write clean'] });
  assert.deepEqual(propagate(example, [], { run: ['write clean'] }), { run: ['write clean'], stale: [] });
});
