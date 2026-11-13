// Merge conflicts by cell. Runs against the built package (dist/).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conflictSides, hasConflictMarkers, mergeCells, resolveCells } from 'smaltnb/conflicts';

const conflicted = `cell('a');
<<<<<<< HEAD
export const a = 3;
=======
export const a = 5;
>>>>>>> other
cell('b');
export const b = 1;
`;

const diff3 = `cell('a');
<<<<<<< ours
export const a = 3;
||||||| base
export const a = 1;
=======
export const a = 5;
>>>>>>> theirs
`;

test('conflictSides: each side whole, the labels, and the common version with diff3 markers', () => {
  assert.equal(hasConflictMarkers(conflicted), true);
  assert.equal(hasConflictMarkers("cell('a');\n// ======= not a conflict\n"), false);
  const s = conflictSides(conflicted);
  assert.equal(s.ours, "cell('a');\nexport const a = 3;\ncell('b');\nexport const b = 1;\n");
  assert.equal(s.theirs, "cell('a');\nexport const a = 5;\ncell('b');\nexport const b = 1;\n");
  assert.deepEqual([s.base, s.oursLabel, s.theirsLabel, s.count], [null, 'HEAD', 'other', 1]);
  const d = conflictSides(diff3);
  assert.equal(d.base, "cell('a');\nexport const a = 1;\n");
  assert.equal(d.theirs, "cell('a');\nexport const a = 5;\n");
  assert.throws(() => conflictSides("<<<<<<< HEAD\nx\n=======\ny\n"), /has no end/);
  assert.throws(() => conflictSides("<<<<<<< a\n<<<<<<< b\n"), /starts inside another at line 2/);
});

test('mergeCells: same, differs, and one side\'s cells placed after their neighbour; base tells added from removed', () => {
  const ours = [{ id: 's', text: 'S' }, { id: 'a', text: 'A3' }, { id: 'mine', text: 'M' }, { id: 'z', text: 'Z' }];
  const theirs = [{ id: 's', text: 'S' }, { id: 'a', text: 'A5' }, { id: 'yours', text: 'Y' }, { id: 'z', text: 'Z' }];
  const base = [{ id: 's', text: 'S' }, { id: 'a', text: 'A1' }, { id: 'mine', text: 'M0' }, { id: 'z', text: 'Z' }];
  const m = mergeCells(ours, theirs, base);
  assert.deepEqual(m.map((c) => `${c.id}:${c.kind}`), ['s:same', 'a:differs', 'yours:theirs-only', 'mine:ours-only', 'z:same']);
  assert.deepEqual(m[1], { id: 'a', kind: 'differs', ours: 'A3', theirs: 'A5', base: 'A1' });
  assert.equal((m[3] as { base: string | null }).base, 'M0', 'theirs removed it');
  assert.equal((m[2] as { base: string | null }).base, null, 'theirs added it');
});

test('resolveCells: a choice per cell; one-sided cells kept unless dropped; a cell that differs needs a choice', () => {
  const m = mergeCells([{ id: 'a', text: 'A3\n' }, { id: 'b', text: 'B' }], [{ id: 'a', text: 'A5\n' }, { id: 'c', text: 'C' }]);
  assert.throws(() => resolveCells(m, {}), /Cell "a" differs/);
  assert.equal(resolveCells(m, { a: 'theirs' }), 'A5\n\nC\n\nB\n', 'c after a, its neighbour in their order');
  assert.equal(resolveCells(m, { a: 'ours', c: 'drop' }), 'A3\n\nB\n');
  assert.equal(resolveCells(m, { a: { text: 'A35' }, b: 'drop' }), 'A35\n\nC\n');
});
