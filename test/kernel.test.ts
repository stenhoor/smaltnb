// Runs against the built package (dist/), imported by name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import { smaltty as ts } from 'smaltkit/typescript';
import { KernelClient, type WorkerLike } from 'smaltnb/client';
import { serveKernel, toDisplay, type CellView } from 'smaltnb/kernel';

const example = readFileSync(new URL('../examples/regional.nb.ts', import.meta.url), 'utf8');

/** A kernel served on one end of a MessageChannel, in this thread. */
function inProcess(): WorkerLike {
  const { port1, port2 } = new MessageChannel();
  serveKernel(port2 as never, { ts });
  return {
    postMessage: (m) => port1.postMessage(m),
    addEventListener: (_t, l) => port1.addEventListener('message', (e) => l({ data: (e as MessageEvent).data })),
    terminate: () => { port1.close(); port2.close(); },
  };
}

/** A kernel in a real worker thread. */
function inWorker(): WorkerLike {
  const w = new Worker(new URL('./fixtures/kernel-worker.mjs', import.meta.url));
  return {
    postMessage: (m) => w.postMessage(m),
    addEventListener: (_t, l) => w.on('message', (data) => l({ data })),
    terminate: () => void w.terminate(),
  };
}

const statuses = (k: KernelClient) => Object.fromEntries(k.states().map((s) => [s.id, s.status]));

test('open sends the notebook and idle cells; runAll reports states and outputs', async () => {
  const seen: string[] = [];
  const k = new KernelClient(inProcess, { onState: (s) => seen.push(`${s.id}:${s.status}`) });
  try {
    await k.open(example, 'regional.nb.ts');
    assert.deepEqual(k.notebook!.order, ['setup', 'types', 'params', 'raw', 'clean', 'byRegion', 'write clean']);
    assert.deepEqual(k.notebook!.diagnostics, []);
    assert.equal(k.state('raw')!.status, 'idle');

    await k.runAll();
    assert.deepEqual(statuses(k), {
      setup: 'ok', types: 'ok', params: 'ok', raw: 'ok', clean: 'ok', byRegion: 'ok', 'write clean': 'idle',
    });
    assert.deepEqual(k.state('byRegion')!.output, { kind: 'value', value: [['north', 79.5], ['south', 7.25]] });
    assert.deepEqual(k.state('clean')!.output, { kind: 'none' });
    assert.ok(seen.includes('byRegion:running') && seen.includes('byRegion:ok'));
  } finally {
    k.close();
  }
});

test('an edit reports the new notebook before anything reruns, then the reactions', async () => {
  const k = new KernelClient(inProcess);
  try {
    await k.open(example);
    await k.runAll();
    await k.update(example.replace("cell('byRegion');", "cell('byRegion', { run: 'manual' });"));
    assert.equal(k.notebook!.cells.find((c) => c.id === 'byRegion')!.run, 'manual');
    assert.equal(k.state('byRegion')!.status, 'stale');
    assert.equal(k.state('byRegion')!.reason, 'edited, not run');

    await k.run(['byRegion']);
    assert.equal(k.state('byRegion')!.status, 'ok');
  } finally {
    k.close();
  }
});

test('diagnostics arrive with the notebook; a cell with an error says why', async () => {
  const k = new KernelClient(inProcess);
  try {
    await k.open(`import { cell } from 'smaltnb';\ncell('a'); const y = x;\ncell('b'); const x = 1;`);
    assert.deepEqual(k.notebook!.diagnostics.map((d) => d.code), ['defined-later']);
    await k.runAll();
    assert.equal(k.state('a')!.status, 'error');
  } finally {
    k.close();
  }
});

test('requests before open, and unknown cells, fail with a message', async () => {
  const k = new KernelClient(inProcess);
  try {
    await assert.rejects(k.runAll(), /No notebook is open/);
    await k.open(example);
    await assert.rejects(k.run(['nope']), /No cell named "nope"/);
  } finally {
    k.close();
  }
});

test('restart stops a cell that never finishes, in a real worker, and opens the notebook again', async () => {
  const source = `import { cell } from 'smaltnb';
cell('fast'); const fast = 1;
cell('forever', { run: 'manual' }); while (true) {}`;
  const k = new KernelClient(inWorker);
  try {
    await k.open(source);
    await k.run(['fast']);
    assert.equal(k.state('fast')!.status, 'ok');

    const stuck = k.run(['forever']);
    const rejected = assert.rejects(stuck, /The kernel was restarted/);
    await waitFor(() => k.state('forever')?.status === 'running');
    await k.restart();
    await rejected;

    assert.deepEqual(statuses(k), { setup: 'idle', fast: 'idle', forever: 'idle' });
    assert.equal(k.state('fast')!.reason, 'the kernel was restarted');
    await k.run(['fast']);
    assert.equal(k.state('fast')!.status, 'ok', 'the new kernel runs cells');
  } finally {
    k.close();
  }
});

test('toDisplay sends values that can be cloned, and describes the rest', () => {
  assert.deepEqual(toDisplay([1, { a: 'x' }]), { kind: 'value', value: [1, { a: 'x' }] });
  assert.deepEqual(toDisplay(new Map([[1, 2]])), { kind: 'value', value: new Map([[1, 2]]) });
  assert.deepEqual(toDisplay(function load() {}), { kind: 'text', text: '[function load]' });
  class Frame { run() {} }
  assert.deepEqual(toDisplay({ f: () => 1 }), { kind: 'text', text: '[object]' });
  assert.deepEqual(toDisplay(new Frame()), { kind: 'value', value: {} }, 'class instances clone as plain objects');
});

test('a CellView has no values: they stay in the kernel', async () => {
  const k = new KernelClient(inProcess);
  try {
    await k.open(example);
    await k.runAll();
    const v: CellView = k.state('raw')!;
    assert.deepEqual(Object.keys(v).sort(), ['error', 'id', 'ms', 'output', 'reason', 'runs', 'status']);
  } finally {
    k.close();
  }
});

async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setImmediate(r));
  }
}
