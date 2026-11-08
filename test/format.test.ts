// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { smaltty as ts } from 'smaltkit/typescript';
import { parseNotebook, sqlBody, type Notebook } from 'smaltnb/format';

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

test('typeDefines lists names that exist only as types', () => {
  const nb = parse(`import { cell } from 'smaltnb';
import type { T } from './t.js';
cell('a'); interface I { n: number } type U = I | T; const v: U = { n: 1 }; enum E { A }`);
  assert.deepEqual(nb.cells[0]!.typeDefines, ['T']);
  assert.deepEqual(nb.cells[1]!.typeDefines, ['I', 'U']);
  assert.deepEqual(nb.cells[1]!.defines, ['I', 'U', 'v', 'E']);
});

const sqlHeader = "import { cell, action, sql, exec } from 'smaltnb';\n";

test('a plain SQL cell is read as its SQL: name, row type, output, and the text with ${} references', () => {
  const nb = parse(sqlHeader + "cell('byRegion', { lang: 'sql' });\nexport const byRegion = sql<{ region: string }>`\n  SELECT region FROM ${orders} -- a `tick`\n`;\nbyRegion;".replace('`tick`', '\\`tick\\`'));
  assert.deepEqual(nb.cells[1]!.sql, {
    kind: 'query', name: 'byRegion', exported: true, rowType: '{ region: string }',
    text: '\n  SELECT region FROM ${orders} -- a `tick`\n', output: true,
  });
});

test('sqlBody writes a plain SQL cell back exactly, escaping backticks', () => {
  const src = sqlHeader + "cell('q', { lang: 'sql' });\nconst q = sql`SELECT '`' AS t, ${n}`;".replace("'`'", "'\\`'");
  const nb = parse(src);
  const view = nb.cells[1]!.sql!;
  assert.equal(view.kind, 'query');
  assert.equal(sqlBody(view), src.slice(src.indexOf('const q')));
  assert.equal(sqlBody({ kind: 'script', statements: ['DELETE FROM t', 'INSERT INTO t SELECT * FROM ${x}'] }),
    'await exec`DELETE FROM t`;\nawait exec`INSERT INTO t SELECT * FROM ${x}`;');
});

test('an action of only exec statements is a SQL script', () => {
  const nb = parse(sqlHeader + "action('save', { lang: 'sql' });\nawait exec`DELETE FROM t`;\nawait exec`INSERT INTO t VALUES (1)`;");
  assert.deepEqual(nb.cells[1]!.sql, { kind: 'script', statements: ['DELETE FROM t', 'INSERT INTO t VALUES (1)'] });
});

test('anything more than SQL keeps a cell TypeScript', () => {
  const cases = [
    "cell('q', { lang: 'sql' });\nconst q = sql`SELECT 1`;\nconsole.log(q);",        // extra code
    "cell('q', { lang: 'sql' });\n// a comment\nconst q = sql`SELECT 1`;",              // a comment outside the SQL
    "cell('q', { lang: 'sql' });\nconst other = sql`SELECT 1`;",                       // the result isn't named after the cell
    "cell('q', { lang: 'sql' });\nlet q = sql`SELECT 1`;",                              // not const
    "cell('q');\nconst q = sql`SELECT 1`;",                                              // not lang: 'sql'
    "action('a', { lang: 'sql' });\nawait exec`DELETE FROM t`;\nconst n = 1;",          // an action with code
    "cell('q', { lang: 'sql' });\nconst q = sql`SELECT 1`;\n// a note\ncell('z');",     // a comment before the next cell
  ];
  for (const c of cases) assert.equal(parse(sqlHeader + c).cells[1]!.sql, null, c);
  const aliased = parse("import { cell, sql as q2 } from 'smaltnb';\ncell('q', { lang: 'sql' });\nconst q = q2`SELECT 1`;");
  assert.equal(aliased.cells[1]!.sql, null, 'sql imported under another name');
});

test('syntax errors: the cell holding one is reported, and the rest of the notebook is read', () => {
  const head = `import { cell } from 'smaltnb';\ncell('a'); export const a = 1;\n`;
  const tail = `cell('c'); export const c = a + 1;\n`;
  const cases: [string, string, string | undefined][] = [
    ['an unfinished expression', `cell('b'); export const b = (a + ;\n`, 'b'],
    ['a brace never closed', `cell('b');\nfunction f() {\n  return a;\n`, 'b'],
    ['a broken cell() line', `cell('b', { run: });\nexport const b = 2;\n`, undefined],
  ];
  for (const [what, middle, cell] of cases) {
    const nb = parse(head + middle + tail);
    const ids = nb.cells.map((c) => c.id);
    assert.ok(ids.includes('a') && ids.includes('c'), `${what}: ${ids}`);
    const syntax = nb.diagnostics.filter((d) => d.code === 'syntax');
    assert.equal(syntax.length, 1, what);
    assert.equal(syntax[0]!.cell, cell, what);
    assert.match(syntax[0]!.message, /line \d+, column \d+: /, what);
    assert.deepEqual(nb.cells.find((c) => c.id === 'c')!.reads, ['a'], `${what}: later cells still read`);
  }
  // In the imports: the setup cell holds it.
  const bad = parse(`import { cell } from 'smaltnb';\nimport { x from 'y';\ncell('a'); export const a = 1;\n`);
  assert.equal(bad.diagnostics.find((d) => d.code === 'syntax')?.cell, 'setup');
});
