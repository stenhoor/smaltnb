// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { parseNotebook, type Notebook } from 'smaltnb/format';

const parse = (source: string): Notebook => parseNotebook(source, ts);
const example = readFileSync(new URL('../examples/regional.nb.ts', import.meta.url), 'utf8');
const codes = (nb: Notebook) => nb.diagnostics.map((d) => d.code);
const cellOf = (nb: Notebook, id: string) => {
  const c = nb.cells.find((x) => x.id === id);
  assert.ok(c, `no cell ${id}`);
  return c;
};

test('the example notebook splits into setup and named cells, with no diagnostics', () => {
  const nb = parse(example);
  assert.deepEqual(nb.diagnostics, []);
  assert.deepEqual(nb.cells.map((c) => [c.id, c.kind]), [
    ['setup', 'setup'], ['types', 'cell'], ['params', 'cell'], ['raw', 'cell'], ['clean', 'cell'], ['byRegion', 'cell'],
    ['write clean', 'action'],
  ]);
  assert.deepEqual(cellOf(nb, 'setup').defines, ['cell', 'action']);
});

test('defines, exports, reads and type reads', () => {
  const nb = parse(example);
  const clean = cellOf(nb, 'clean');
  assert.deepEqual(clean.defines, ['clean']);
  assert.deepEqual(clean.exports, ['clean']);
  assert.deepEqual(clean.reads.sort(), ['params', 'raw']);
  const raw = cellOf(nb, 'raw');
  assert.deepEqual(raw.reads, []);
  assert.deepEqual(raw.typeReads, ['Order'], 'Order is used only as a type');
  assert.deepEqual(cellOf(nb, 'types').exports, ['Order']);
  const write = cellOf(nb, 'write clean');
  assert.deepEqual(write.defines, ['written']);
  assert.deepEqual(write.exports, []);
  assert.deepEqual(write.reads, ['clean']);
});

test('options and guards are read without running anything', () => {
  const nb = parse(example);
  assert.equal(cellOf(nb, 'clean').run, 'lazy');
  assert.equal(cellOf(nb, 'raw').run, 'auto');
  const write = cellOf(nb, 'write clean');
  assert.deepEqual(write.when, { text: "() => params.mode === 'full'", reads: ['params'] });
});

test('a cell that ends with an expression has an output span', () => {
  const nb = parse(example);
  const out = cellOf(nb, 'byRegion').output;
  assert.ok(out);
  assert.equal(example.slice(out.start, out.end), 'byRegion');
  assert.equal(cellOf(nb, 'clean').output, null);
});

test('cell and action can be imported under other names', () => {
  const nb = parse(`import { cell as c, action as a } from 'smaltnb';
c('one'); const x = 1;
a('two'); x;`);
  assert.deepEqual(nb.diagnostics, []);
  assert.deepEqual(nb.cells.map((c) => [c.id, c.kind]), [['setup', 'setup'], ['one', 'cell'], ['two', 'action']]);
});

test('shadowed names, property names and shorthand properties', () => {
  const nb = parse(`import { cell } from 'smaltnb';
cell('a'); const raw = [1, 2];
cell('b');
const f = (raw: number[]) => raw.length;
const o = { raw: 1 }.raw;
cell('c');
const p = { raw };`);
  assert.deepEqual(nb.diagnostics, []);
  assert.deepEqual(nb.cells.find((c) => c.id === 'b')!.reads, [], 'a parameter and a property named raw are not reads');
  assert.deepEqual(nb.cells.find((c) => c.id === 'c')!.reads, ['raw'], '{ raw } reads raw');
});

test('class extends is a value read; implements is a type read', () => {
  const nb = parse(`import { cell } from 'smaltnb';
cell('a'); class Base {} interface Shape { n: number }
cell('b'); class Sq extends Base implements Shape { n = 1 }`);
  const b = nb.cells.find((c) => c.id === 'b')!;
  assert.deepEqual(b.reads, ['Base']);
  assert.deepEqual(b.typeReads, ['Shape']);
});

test('a notebook reads top to bottom, except for function declarations', () => {
  const later = parse(`import { cell } from 'smaltnb';
cell('a'); const y = x + 1;
cell('b'); const x = 1;`);
  assert.deepEqual(codes(later), ['defined-later']);
  assert.match(later.diagnostics[0]!.message, /"x" is defined further down, in cell "b"/);

  const hoisted = parse(`import { cell } from 'smaltnb';
cell('a'); const y = twice(2);
cell('b'); function twice(n: number) { return n * 2; }`);
  assert.deepEqual(codes(hoisted), []);
  assert.deepEqual(hoisted.cells[1]!.reads, ['twice']);
});

test('a top-level name is assigned only in its own cell', () => {
  const nb = parse(`import { cell } from 'smaltnb';
cell('a'); let n = 1;
cell('b'); n = 2; n++;`);
  assert.deepEqual(codes(nb), ['assign-elsewhere', 'assign-elsewhere']);
});

test('setup holds imports only, and imports stay in setup', () => {
  const nb = parse(`import { cell } from 'smaltnb';
const early = 1;
cell('a');
import { other } from './other.js';`);
  assert.deepEqual(codes(nb).sort(), ['import-in-cell', 'setup-code']);
});

test('cell names are string literals and unique', () => {
  const nb = parse(`import { cell } from 'smaltnb';
const name = 'x';
cell(name);
cell('dup'); cell('dup');`);
  assert.deepEqual(codes(nb).sort(), ['cell-name', 'duplicate-name', 'setup-code']);
});

test('options are checked: literals, known keys, allowed values, and no run mode on an action', () => {
  const nb = parse(`import { cell, action } from 'smaltnb';
const opts = {};
cell('a', opts);
cell('b', { lang: 'python' });
cell('c', { colour: 'red' });
cell('d', { live: 1 });
cell('e', { when: true });
action('f', { run: 'auto' });`);
  const options = nb.diagnostics.filter((d) => d.code === 'cell-options');
  assert.deepEqual(options.map((d) => d.cell), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.match(options[5]!.message, /An action never reruns on its own/);
});

test('default exports are reserved for the notebook factory', () => {
  const nb = parse(`import { cell } from 'smaltnb';
cell('a'); export default 1;`);
  assert.deepEqual(codes(nb), ['export-default']);
});

test('export lists are attributed to the cell that defines the name', () => {
  const nb = parse(`import { cell } from 'smaltnb';
cell('a'); const x = 1;
cell('b'); export { x };
cell('c'); export { nope };`);
  assert.deepEqual(nb.cells.find((c) => c.id === 'a')!.exports, ['x']);
  assert.deepEqual(nb.cells.find((c) => c.id === 'b')!.exports, []);
  assert.deepEqual(codes(nb), ['export-unknown']);
});

test('a file without cell imports is all setup, with a warning', () => {
  const nb = parse(`const x = 1;`);
  assert.deepEqual(codes(nb).sort(), ['no-cells', 'setup-code']);
});

test('spans give 1-based lines', () => {
  const nb = parse(example);
  const clean = cellOf(nb, 'clean');
  const lines = example.split('\n');
  assert.match(lines[clean.span.line - 1]!, /^cell\('clean'/);
  assert.match(lines[clean.body!.line - 1]!, /^export const clean/);
});
