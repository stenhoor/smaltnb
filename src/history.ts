// A cell's history in git (ADR 0032): from the versions of a notebook in its commits, newest first, the commits that
// changed one cell, and blame: for each line of the cell as it is now, the commit that last changed it. Nothing here
// reads git: the page gives it each commit's text of the cell (reading .git with smaltkit/git) and a line diff.

/** One commit's version of a cell: null when the commit's notebook has no such cell. */
export interface CellVersion<C> {
  commit: C;
  text: string | null;
}

/** A change to a cell: the commit, the cell's text there, and its text just before (null: the commit added the cell). */
export interface CellChange<C> {
  commit: C;
  text: string;
  before: string | null;
}

/**
 * The commits that changed a cell, newest first, from its versions newest first (a commit and the one before it on the
 * file's history). A commit whose text is the same as the one before it is left out; the oldest version that has the
 * cell is where it was added. A version without the cell ends the history (the cell didn't exist before it, or had
 * another name).
 */
export function cellChanges<C>(versions: CellVersion<C>[]): CellChange<C>[] {
  const out: CellChange<C>[] = [];
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]!;
    if (v.text === null) break;
    const before = i + 1 < versions.length ? versions[i + 1]!.text : null;
    if (before !== v.text) out.push({ commit: v.commit, text: v.text, before });
    if (before === null) break;
  }
  return out;
}

/** A line diff, as smaltkit/git's `diffLines` gives it. */
export type LineDiff = (a: string, b: string) => { op: 'keep' | 'remove' | 'add'; text: string }[];

/** For each line of `b`, its line number in `a` (0-based), or -1 when the diff adds it. */
function mapLines(diff: LineDiff, a: string, b: string): number[] {
  const out: number[] = [];
  let ia = 0;
  for (const l of diff(a, b)) {
    if (l.op === 'keep') out.push(ia++);
    else if (l.op === 'remove') ia++;
    else out.push(-1);
  }
  return out;
}

/**
 * Blame for a cell's current text: for each line, the commit that last changed it, or null for a line not committed
 * yet (changed in the working file). `changes` are the cell's changes, newest first, as `cellChanges` gives them.
 */
export function blameLines<C>(current: string, changes: CellChange<C>[], diff: LineDiff): { text: string; commit: C | null }[] {
  const lines = current === '' ? [] : current.split('\n');
  const owner: (C | null)[] = lines.map(() => null);
  if (!changes.length) return lines.map((text) => ({ text, commit: null }));
  // Where each current line is in the newest committed version; lines not there are uncommitted.
  let at = mapLines(diff, changes[0]!.text, current);
  let open = at.map((i, k) => (i >= 0 ? k : -1)).filter((k) => k >= 0);
  for (const [n, ch] of changes.entries()) {
    if (!open.length) break;
    // Lines of this version that the version before it doesn't have were changed here.
    const back = ch.before === null ? null : mapLines(diff, ch.before, ch.text);
    const still: number[] = [];
    for (const k of open) {
      const here = at[k]!;
      const older = back === null ? -1 : back[here]!;
      if (older < 0 || n === changes.length - 1) owner[k] = ch.commit;
      else still.push(k);
    }
    if (back === null) break; // the change that added the cell: every line still open is its
    // The version before this change is the next change's text (commits that changed nothing were left out).
    at = at.map((i) => (i >= 0 ? back[i] ?? -1 : -1));
    open = still;
  }
  return lines.map((text, k) => ({ text, commit: owner[k]! }));
}
