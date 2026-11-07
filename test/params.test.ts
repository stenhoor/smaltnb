// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import ts from 'typescript';
import { param, type ParamInfo } from 'smaltnb/params';
import { createRuntime, type RuntimeOptions } from 'smaltnb/runtime';
import { KernelClient } from 'smaltnb/client';
import { serveKernel } from 'smaltnb/kernel';

const notebook = `import { cell, action, param } from 'smaltnb';
cell('params');
export const params = param({
  mode: param.choice(['incremental', 'full'], 'incremental'),
  since: param.isoDate('2026-10-01'),
  minQty: param.number(1),
  dry: param.bool(true),
  label: param.text('orders'),
});
cell('summary');
export const summary = \`\${params.label} since \${params.since}, qty >= \${params.minQty}, \${params.mode}\`;
summary;
action('write', { when: () => params.mode === 'full' });
const wrote = !params.dry;
`;

const runtime = (options: Partial<RuntimeOptions> = {}) => createRuntime(notebook, { ts, ...options });

test('outside a running notebook, param() gives the defaults, typed', () => {
  const p = param({ mode: param.choice(['a', 'b'], 'a'), n: param.number(3), on: param.bool(false), d: param.isoDate('2026-01-31') });
  const mode: 'a' | 'b' = p.mode;
  assert.deepEqual({ ...p }, { mode, n: 3, on: false, d: '2026-01-31' });
  assert.ok(Object.isFrozen(p));
  assert.throws(() => param.isoDate('2026-02-30'), /not a date written YYYY-MM-DD/);
});

test('the runtime reports the parameters a notebook declares, with their values', async () => {
  const seen: ParamInfo[][] = [];
  const rt = runtime({ onParams: (p) => seen.push(p) });
  await rt.runAll();
  assert.equal(rt.state('summary')!.output, 'orders since 2026-10-01, qty >= 1, incremental');
  assert.deepEqual(rt.params().map((p) => [p.name, p.kind, p.value, p.cell]), [
    ['mode', 'choice', 'incremental', 'params'], ['since', 'isoDate', '2026-10-01', 'params'],
    ['minQty', 'number', '1', 'params'], ['dry', 'bool', 'true', 'params'], ['label', 'text', 'orders', 'params'],
  ]);
  assert.deepEqual(rt.params()[0]!.choices, ['incremental', 'full']);
  assert.equal(seen.length, 1, 'reported once when declared');
});

test('values from outside, as text, are checked and typed', async () => {
  const rt = runtime({ params: { mode: 'full', minQty: '5', dry: 'false', since: '2026-11-01' } });
  await rt.runAll({ actions: true });
  assert.equal(rt.state('summary')!.output, 'orders since 2026-11-01, qty >= 5, full');
  assert.equal(rt.state('write')!.status, 'ok', 'the guard read the parameter');
  assert.equal(rt.value('wrote'), true);
});

test('setParams reruns the declaring cell and what reads it; null goes back to the default', async () => {
  const rt = runtime();
  await rt.runAll();
  await rt.setParams({ minQty: '7' });
  assert.equal(rt.state('summary')!.output, 'orders since 2026-10-01, qty >= 7, incremental');
  assert.equal(rt.params().find((p) => p.name === 'minQty')!.value, '7');
  await rt.setParams({ minQty: null });
  assert.equal(rt.state('summary')!.output, 'orders since 2026-10-01, qty >= 1, incremental');
});

test('setting a guard parameter makes an action stale, not run', async () => {
  const rt = runtime();
  await rt.runAll();
  await rt.setParams({ mode: 'full' });
  assert.equal(rt.state('write')!.status, 'idle', 'never run, so nothing to mark stale');
  await rt.run(['write']);
  assert.equal(rt.state('write')!.status, 'ok');
  await rt.setParams({ dry: 'false' });
  assert.equal(rt.state('write')!.status, 'stale');
});

test('a value that does not fit is an error on the declaring cell, with the reason', async () => {
  const rt = runtime({ params: { mode: 'sometimes' } });
  await rt.runAll();
  assert.equal(rt.state('params')!.status, 'error');
  assert.match(rt.state('params')!.reason!, /Parameter "mode": "sometimes" is not one of "incremental", "full"\./);
  assert.equal(rt.state('summary')!.status, 'stale');
  await rt.setParams({ mode: 'full' });
  assert.equal(rt.state('params')!.status, 'ok');
  assert.equal(rt.state('summary')!.status, 'ok');
  for (const [name, bad, why] of [['minQty', 'x', /not a number/], ['dry', 'yes', /not true or false/], ['since', '2026-13-01', /YYYY-MM-DD/]] as const) {
    await rt.setParams({ [name]: bad });
    assert.match(rt.state('params')!.reason!, why);
    await rt.setParams({ [name]: null });
  }
});

test('a parameter is declared in one cell only', async () => {
  const rt = createRuntime(`import { cell, param } from 'smaltnb';
cell('a'); export const a = param({ n: param.number(1) });
cell('b'); export const b = param({ n: param.number(2) });`, { ts });
  await rt.runAll();
  assert.equal(rt.state('b')!.status, 'error');
  assert.match(rt.state('b')!.reason!, /Parameter "n" is already declared in cell "a"/);
});

test('removing the declaring cell removes its parameters', async () => {
  const rt = runtime();
  await rt.runAll();
  await rt.update(`import { cell } from 'smaltnb';\ncell('only'); const x = 1;`);
  assert.deepEqual(rt.params(), []);
});

test('through the kernel: parameters arrive with onParams; setParams reruns; restart keeps the values', async () => {
  const { port1, port2 } = new MessageChannel();
  serveKernel(port2 as never, { ts });
  const seen: string[] = [];
  const k = new KernelClient(() => ({
    postMessage: (m) => port1.postMessage(m),
    addEventListener: (_t, l) => port1.addEventListener('message', (e) => l({ data: (e as MessageEvent).data })),
    terminate: () => {},
  }), { onParams: (p) => seen.push(p.map((x) => `${x.name}=${x.value}`).join(',')) });
  try {
    await k.open(notebook, 'p.nb.ts', { minQty: '3' });
    await k.runAll();
    assert.equal(k.params.find((p) => p.name === 'minQty')!.value, '3');
    await k.setParams({ label: 'sales' });
    assert.deepEqual(k.state('summary')!.output, { kind: 'value', value: 'sales since 2026-10-01, qty >= 3, incremental' });
    assert.ok(seen.at(-1)!.includes('label=sales'));
  } finally {
    port1.close();
    port2.close();
  }
});
