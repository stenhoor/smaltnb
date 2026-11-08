// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smaltty } from 'smaltkit/typescript';
import { md, Markdown } from 'smaltnb/md';
import { parseNotebook, sqlBody } from 'smaltnb/format';
import { createRuntime } from 'smaltnb/runtime';
import { view } from 'smaltnb/kernel';

const head = "import { cell, md, param } from 'smaltnb';\n";

test('md`…` is Markdown text: values are put in as text; backslashes are kept (a Markdown escape like \\_ survives)', () => {
  const n = 3;
  const m = md`# Orders\nAt least **${n}**, see \`code\` and a\_b.`;
  assert.ok(m instanceof Markdown);
  assert.equal(m.text, '# Orders\\nAt least **3**, see `code` and a\\_b.');
});

test('a plain Markdown cell is read as its text, and written back exactly', () => {
  const src = head + "cell('intro', { lang: 'md' });\nmd`# Shop\nRevenue by **region**, \\`code\\` too.`;";
  const nb = parseNotebook(src, smaltty);
  const v = nb.cells[1]!.sql;
  assert.deepEqual(v, { kind: 'md', text: '# Shop\nRevenue by **region**, `code` too.' });
  assert.equal(sqlBody(v!), src.slice(src.indexOf('md`')));
});

test('a Markdown cell with anything more stays TypeScript', () => {
  for (const c of [
    "cell('a', { lang: 'md' });\nconst x = 1;\nmd`x`;",
    "cell('a', { lang: 'md' });\n// note\nmd`x`;",
    "cell('a');\nmd`x`;",
  ]) assert.equal(parseNotebook(head + c, smaltty).cells[1]!.sql, null, c);
});

test('the runtime gives a Markdown output, with the notebook values in it; the page gets it as markdown', async () => {
  const rt = createRuntime(head + `cell('params'); export const params = param({ minQty: param.number(2) });
cell('intro', { lang: 'md' });
md\`Orders of at least **\${params.minQty}**.\`;`, { ts: smaltty });
  await rt.runAll();
  const s = rt.state('intro')!;
  assert.equal(s.status, 'ok');
  assert.deepEqual(view(s).output, { kind: 'markdown', text: 'Orders of at least **2**.' });
  await rt.setParams({ minQty: '5' });
  assert.deepEqual(view(rt.state('intro')!).output, { kind: 'markdown', text: 'Orders of at least **5**.' });
});
