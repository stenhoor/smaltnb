// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { smaltty as ts } from 'smaltkit/typescript';
import { createRuntime, type CellState, type RuntimeOptions } from 'smaltnb/runtime';

const example = readFileSync(new URL('../examples/regional.nb.ts', import.meta.url), 'utf8');
const runtime = (source: string, options: Partial<RuntimeOptions> = {}) => createRuntime(source, { ts, ...options });
const status = (rt: ReturnType<typeof runtime>) => Object.fromEntries(rt.states().map((s) => [s.id, s.status]));

test('runAll runs every cell in order, but not actions', async () => {
  const rt = runtime(example);
  await rt.runAll();
  assert.deepEqual(status(rt), {
    setup: 'ok', types: 'ok', params: 'ok', raw: 'ok', clean: 'ok', byRegion: 'ok', 'write clean': 'idle',
  });
  assert.deepEqual(rt.value('byRegion'), [['north', 79.5], ['south', 7.25]]);
  const byRegion = rt.state('byRegion')!;
  assert.equal(byRegion.hasOutput, true);
  assert.deepEqual(byRegion.output, rt.value('byRegion'), 'the last expression is the output');
  assert.equal(rt.state('clean')!.hasOutput, false);
  assert.equal(rt.state('clean')!.runs, 1);
});

test('a headless run includes actions, which still respect their guards', async () => {
  const rt = runtime(example);
  await rt.runAll({ actions: true });
  const write = rt.state('write clean')!;
  assert.equal(write.status, 'skipped');
  assert.equal(write.reason, "when () => params.mode === 'full' is false");
});

test('an edit reruns auto cells; a lazy cell goes stale with everything after it', async () => {
  const rt = runtime(example);
  await rt.runAll();
  await rt.update(example.replace("{ region: 'south', qty: 1, price: 7.25 }", "{ region: 'south', qty: 4, price: 7.25 }"));
  assert.deepEqual(status(rt), {
    setup: 'ok', types: 'ok', params: 'ok', raw: 'ok', clean: 'stale', byRegion: 'stale', 'write clean': 'idle',
  });
  assert.equal(rt.state('clean')!.reason, 'an input changed');
  assert.deepEqual(rt.value('byRegion'), [['north', 79.5], ['south', 7.25]], 'stale cells keep their last result');

  await rt.run(['clean']);
  assert.equal(rt.state('clean')!.status, 'ok');
  assert.equal(rt.state('byRegion')!.status, 'ok', 'running clean reruns the auto cell after it');
  assert.deepEqual(rt.value('byRegion'), [['north', 79.5], ['south', 29]]);
});

test('an action never runs on its own: it goes stale and waits for Run', async () => {
  const full = example.replace("mode: 'incremental' as", "mode: 'full' as");
  const lines: string[] = [];
  const rt = runtime(full.replace('console.log(`would write ${written} rows`);', 'log(`would write ${written} rows`);')
    .replace("import { cell, action } from 'smaltnb';", "import { cell, action } from 'smaltnb';\nimport { log } from 'test:log';"), {
    importModule: async () => ({ log: (s: string) => lines.push(s) }),
  });
  await rt.runAll();
  await rt.run(['write clean']);
  assert.equal(rt.state('write clean')!.status, 'ok');
  assert.deepEqual(lines, ['would write 3 rows']);

  await rt.update(rt.source.replace('minQty: 1', 'minQty: 2'));
  assert.equal(rt.state('write clean')!.status, 'stale');
  assert.equal(rt.state('write clean')!.reason, 'inputs changed since last run');
  assert.deepEqual(lines, ['would write 3 rows'], 'the action did not run again');
});

test('Run once anyway ignores the guard', async () => {
  const rt = runtime(example);
  await rt.runAll();
  await rt.run(['write clean'], { force: true });
  assert.equal(rt.state('write clean')!.status, 'ok');
});

test('a failing cell keeps its error; cells after it wait', async () => {
  const rt = runtime(`import { cell } from 'smaltnb';
cell('a'); const a = 1;
cell('b'); const b: number = (a as any).nope.deeper;
cell('c'); const c = b + 1;`);
  await rt.runAll();
  assert.deepEqual(status(rt), { setup: 'ok', a: 'ok', b: 'error', c: 'stale' });
  assert.match(rt.state('b')!.error!.message, /deeper/);
  assert.equal(rt.state('c')!.reason, 'waiting for "b"');

  await rt.update(rt.source.replace('(a as any).nope.deeper', 'a * 10'));
  assert.deepEqual(status(rt), { setup: 'ok', a: 'ok', b: 'ok', c: 'ok' });
  assert.equal(rt.value('c'), 11);
});

test('cells after a skipped cell are skipped too and keep their last result', async () => {
  const src = (on: boolean) => `import { cell } from 'smaltnb';
cell('p'); const on = ${on};
cell('a', { when: () => on }); const a = 1;
cell('b'); const b = a + 1;`;
  const rt = runtime(src(true));
  await rt.runAll();
  assert.equal(rt.value('b'), 2);
  await rt.update(src(false));
  assert.deepEqual(status(rt), { setup: 'ok', p: 'ok', a: 'skipped', b: 'skipped' });
  assert.equal(rt.state('b')!.reason, '"a" was skipped');
  assert.equal(rt.value('b'), 2);
});

test('a cell with an error in the notebook does not run, and says why', async () => {
  const rt = runtime(`import { cell } from 'smaltnb';
cell('a'); const y = x + 1;
cell('b'); const x = 1;`);
  await rt.runAll();
  assert.equal(rt.state('a')!.status, 'error');
  assert.match(rt.state('a')!.reason!, /defined further down/);
});

test('the setup cell loads imports: named, renamed, default, namespace; type-only imports are dropped', async () => {
  const loaded: string[] = [];
  const rt = runtime(`import { cell } from 'smaltnb';
import { add, add as plus } from 'math';
import greet, * as all from 'greet';
import type { Nothing } from 'types-only';
cell('a'); const n: Nothing | number = plus(add(1, 2), 3);
cell('b'); const s = greet(String(n)) + Object.keys(all).length;`, {
    importModule: async (spec) => {
      loaded.push(spec);
      return spec === 'math' ? { add: (x: number, y: number) => x + y } : { default: (s: string) => `hi ${s}`, other: 1 };
    },
  });
  await rt.runAll();
  assert.deepEqual(status(rt), { setup: 'ok', a: 'ok', b: 'ok' });
  assert.equal(rt.value('s'), 'hi 62');
  assert.deepEqual(loaded, ['math', 'greet']);
});

test('a missing export or loader is a setup error', async () => {
  const rt = runtime(`import { cell } from 'smaltnb';
import { nope } from 'math';
cell('a'); const a = nope;`, { importModule: async () => ({}) });
  await rt.runAll();
  assert.equal(rt.state('setup')!.status, 'error');
  assert.match(rt.state('setup')!.reason!, /'math' has no export named 'nope'/);
  assert.equal(rt.state('a')!.status, 'stale');
});

test('TypeScript runs: types are stripped, classes run, exports become plain names', async () => {
  const rt = runtime(`import { cell } from 'smaltnb';
cell('a');
export interface P { x: number }
export const Color = { Red: 0, Green: 1 } as const;
export class Box<T> { readonly v: T; constructor(v: T) { this.v = v; } }
const values = [1, 2];
export { values };
cell('b'); const total: number = values.reduce((s, v) => s + v, 0) + Color.Green + new Box<number>(10).v;
total;`);
  await rt.runAll();
  assert.deepEqual(status(rt), { setup: 'ok', a: 'ok', b: 'ok' });
  assert.equal(rt.state('b')!.output, 14);
  assert.deepEqual(Object.keys(rt.state('a')!.values).sort(), ['Box', 'Color', 'values'], 'P is a type, not a value');
});

test('code that would need compiling (an enum) is an error on its cell, with where and what to write', async () => {
  const rt = runtime(`import { cell } from 'smaltnb';
cell('a'); export const one = 1;
cell('b');
enum Color { Red, Green }
export const green = Color.Green;
cell('c'); export const two = one + 1;`);
  await rt.runAll();
  assert.deepEqual(status(rt), { setup: 'ok', a: 'ok', b: 'error', c: 'ok' });
  assert.match(rt.state('b')!.error!.message, /^notebook\.nb\.ts, line 4, column 1: An enum makes code.*as const/, 'the notebook\'s line and column');
});

test('a syntax error stops only its cell: the others are read and run', async () => {
  const rt = runtime(`import { cell } from 'smaltnb';
cell('a'); export const one = 1;
cell('b'); export const broken = (one + ;
cell('c'); export const two = one + 1;
two;`);
  await rt.runAll();
  assert.deepEqual(status(rt), { setup: 'ok', a: 'ok', b: 'error', c: 'ok' });
  assert.equal(rt.state('c')!.output, 2);
  assert.match(rt.state('b')!.error!.message, /line 3, column \d+: /);
  const syntax = rt.diagnostics.find((d) => d.code === 'syntax');
  assert.equal(syntax?.cell, 'b');
  assert.equal(syntax?.span?.line, 3);
  // Fixed, it runs.
  await rt.update(rt.source.replace('(one + ;', '(one + 1);'));
  await rt.run(['b']);
  assert.equal(rt.value('broken'), 2);
});

test('top-level await works in a cell and in a guard', async () => {
  const rt = runtime(`import { cell } from 'smaltnb';
cell('a'); const v = await Promise.resolve(5);
cell('b', { when: () => v > 1 }); const w = v * 2;`);
  await rt.runAll();
  assert.equal(rt.value('w'), 10);
});

test('removing a cell drops it; cells that read it change too', async () => {
  const rt = runtime(`import { cell } from 'smaltnb';
cell('a'); const a = 1;
cell('b'); const b = a + 1;`);
  await rt.runAll();
  await rt.update(`import { cell } from 'smaltnb';
cell('b'); const b = 2;`);
  assert.deepEqual(status(rt), { setup: 'ok', b: 'ok' });
  assert.equal(rt.state('a'), undefined);
});

test('onChange reports each state change, and runs never interleave', async () => {
  const seen: string[] = [];
  const rt = runtime(`import { cell } from 'smaltnb';
cell('a'); const a = 1;
cell('b'); const b = a + 1;`, { onChange: (s: CellState) => seen.push(`${s.id}:${s.status}`) });
  await Promise.all([rt.runAll(), rt.run(['b'])]);
  assert.deepEqual(seen, ['setup:running', 'setup:ok', 'a:running', 'a:ok', 'b:running', 'b:ok', 'b:running', 'b:ok']);
});

test('run() names an unknown cell clearly', async () => {
  await assert.rejects(runtime(example).run(['nope']), /No cell named "nope"/);
});
