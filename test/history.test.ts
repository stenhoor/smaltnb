// A cell's history: the commits that changed it, and blame. Runs against the built package (dist/).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines } from 'smaltkit/git';
import { blameLines, cellChanges } from 'smaltnb/history';

// Versions of a cell, newest first: c5 (same as c4), c4 changed line b, c3 the same as c2, c2 added line c, c1 added it.
const versions = [
  { commit: 'c5', text: 'a\nB\nc' },
  { commit: 'c4', text: 'a\nB\nc' },
  { commit: 'c3', text: 'a\nb\nc' },
  { commit: 'c2', text: 'a\nb\nc' },
  { commit: 'c1', text: 'a\nb' },
  { commit: 'c0', text: null },
];

test('cellChanges: only the commits that changed the cell, newest first, back to the one that added it', () => {
  assert.deepEqual(cellChanges(versions), [
    { commit: 'c4', text: 'a\nB\nc', before: 'a\nb\nc' },
    { commit: 'c2', text: 'a\nb\nc', before: 'a\nb' },
    { commit: 'c1', text: 'a\nb', before: null },
  ]);
  assert.deepEqual(cellChanges([{ commit: 'x', text: null }]), []);
  assert.deepEqual(cellChanges([{ commit: 'only', text: 't' }]), [{ commit: 'only', text: 't', before: null }]);
});

test('blameLines: each line to the commit that last changed it; uncommitted lines to none', () => {
  const changes = cellChanges(versions);
  const show = (current: string) => blameLines(current, changes, diffLines).map((l) => `${l.commit ?? '-'}:${l.text}`);
  assert.deepEqual(show('a\nB\nc'), ['c1:a', 'c4:B', 'c2:c']);
  assert.deepEqual(show('a\nB\nnew\nc'), ['c1:a', 'c4:B', '-:new', 'c2:c'], 'a line not committed yet');
  assert.deepEqual(show('B\nc'), ['c4:B', 'c2:c']);
  assert.deepEqual(blameLines('x\ny', [], diffLines).map((l) => l.commit), [null, null], 'no history: all uncommitted');
});

test('blameLines: history cut short (a limit) gives the oldest change what is older', () => {
  const changes = cellChanges(versions).slice(0, 2); // c4, c2: c1 not read
  assert.deepEqual(blameLines('a\nB\nc', changes, diffLines).map((l) => l.commit), ['c2', 'c4', 'c2']);
});
