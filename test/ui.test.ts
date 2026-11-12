// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { smaltty } from 'smaltkit/typescript';
import { ui } from 'smaltnb/ui';
import { createRuntime } from 'smaltnb/runtime';
import { serveKernel } from 'smaltnb/kernel';
import { KernelClient } from 'smaltnb/client';

const head = "import { cell, ui } from 'smaltnb';\n";
const source = head + `cell('pick');
const region = ui.select(['all', 'north', 'south'], 'all', { label: 'Region' });
const n = ui.slider(0, 10, 3);
export const picked = region.value + ':' + n.value;
cell('after'); export const shout = picked.toUpperCase();
`;

test('outside a running notebook each control has its default; bad defaults throw', () => {
  assert.equal(ui.select(['a', 'b'], 'b').value, 'b');
  assert.equal(ui.slider(0, 10, 4).value, 4);
  assert.equal(ui.number(2.5, { min: 0 }).value, 2.5);
  assert.equal(ui.text('hi').value, 'hi');
  assert.equal(ui.checkbox(true).value, true);
  assert.equal(ui.date('2026-11-12').value, '2026-11-12');
  assert.throws(() => ui.select(['a'], 'z' as 'a'), /the default "z" is not one of the options/);
  assert.throws(() => ui.slider(0, 10, 11), /not between 0 and 10/);
  assert.throws(() => ui.date('12/11/2026'), /not a date written YYYY-MM-DD/);
});

test('a cell\'s controls are in its state, in order; setControl reruns the cell and what reads it', async () => {
  const rt = createRuntime(source, { ts: smaltty });
  await rt.runAll();
  assert.deepEqual(rt.state('pick')!.controls, [
    { index: 0, kind: 'select', label: 'Region', value: 'all', default: 'all', options: ['all', 'north', 'south'] },
    { index: 1, kind: 'slider', label: null, value: 3, default: 3, min: 0, max: 10 },
  ]);
  await rt.setControl('pick', 0, 'north');
  assert.equal(rt.value('shout'), 'NORTH:3');
  await rt.setControl('pick', 1, 7);
  assert.equal(rt.value('shout'), 'NORTH:7');
  await rt.setControl('pick', 0, null);
  assert.equal(rt.value('shout'), 'ALL:7');
  assert.deepEqual(rt.state('pick')!.controls.map((c) => c.value), ['all', 7]);
});

test('a value that no longer fits the control (out of range, not an option) falls back to the default', async () => {
  const rt = createRuntime(source, { ts: smaltty });
  await rt.runAll();
  await rt.setControl('pick', 1, 99);
  assert.equal(rt.value('picked'), 'all:3');
  await rt.setControl('pick', 0, 'south');
  await rt.update(source.replace("'north', 'south'", "'north', 'east'"));
  await rt.run(['pick']);
  assert.equal(rt.value('picked'), 'all:3');
});

test('a cell that fails keeps the controls it declared, so the value that caused it can be changed', async () => {
  const rt = createRuntime(head + `cell('a');
const n = ui.number(1);
if (n.value > 5) throw new Error('too many');
export const x = n.value;`, { ts: smaltty });
  await rt.runAll();
  await rt.setControl('a', 0, 9);
  const s = rt.state('a')!;
  assert.equal(s.status, 'error');
  assert.deepEqual(s.controls.map((c) => c.value), [9]);
  await rt.setControl('a', 0, 2);
  assert.equal(rt.value('x'), 2);
});

test('through the kernel: the page gets the controls, sets one, and a restart keeps the value', async () => {
  const client = new KernelClient(() => {
    const ch = new MessageChannel();
    serveKernel(ch.port2 as never, { ts: smaltty });
    const port = ch.port1;
    return {
      postMessage: (m: unknown) => port.postMessage(m),
      addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => port.on('message', (data) => l({ data })),
      terminate: () => { port.close(); ch.port2.close(); },
    };
  });
  try {
    await client.open(source, 'x.nb.ts');
    await client.runAll();
    assert.deepEqual(client.state('pick')!.controls.map((c) => c.kind), ['select', 'slider']);
    await client.setControl('pick', 1, 9);
    assert.equal(client.state('pick')!.controls[1]!.value, 9);
    await client.restart();
    await client.runAll();
    assert.equal(client.state('pick')!.controls[1]!.value, 9);
  } finally {
    client.close();
  }
});
