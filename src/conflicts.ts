// Merge conflicts by cell (ADR 0032). When a merge in the user's own git tools conflicts, git writes conflict markers
// into the notebook file. This reads them: the file as each side has it ("ours", between `<<<<<<<` and `=======`, and
// "theirs", between `=======` and `>>>>>>>`; with diff3 markers, the common version between `|||||||` and `=======`),
// then, once the page has split each side into cells, which cells differ, and the notebook with a choice made for each.
// Nothing here reads or writes git: the user marks the file resolved and commits in their own tools.

export interface ConflictSides {
  ours: string;
  theirs: string;
  /** The common version, when the markers carry it (`merge.conflictStyle = diff3` or `zdiff3`); else null. */
  base: string | null;
  /** What git named each side: `HEAD`, a branch name. */
  oursLabel: string;
  theirsLabel: string;
  /** How many conflicts the file has. */
  count: number;
}

const OPEN = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SPLIT = /^={7}$/;
const CLOSE = /^>{7}(?: (.*))?$/;

/** Whether the text has git's conflict markers (a line that starts a conflict and one that ends it). */
export function hasConflictMarkers(text: string): boolean {
  const lines = text.split('\n');
  return lines.some((l) => OPEN.test(l)) && lines.some((l) => CLOSE.test(l));
}

/** Each side of a conflicted file, whole. Throws when the markers don't nest as git writes them. */
export function conflictSides(text: string): ConflictSides {
  const ours: string[] = [];
  const theirs: string[] = [];
  const base: string[] = [];
  let withBase = false;
  let state: 'both' | 'ours' | 'base' | 'theirs' = 'both';
  let oursLabel = '';
  let theirsLabel = '';
  let count = 0;
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const at = `line ${i + 1}`;
    let m: RegExpMatchArray | null;
    if ((m = line.match(OPEN))) {
      if (state !== 'both') throw new Error(`A conflict starts inside another at ${at}.`);
      state = 'ours';
      oursLabel ||= m[1] ?? '';
      count++;
    } else if (BASE.test(line) && state === 'ours') {
      state = 'base';
      withBase = true;
    } else if (SPLIT.test(line) && (state === 'ours' || state === 'base')) {
      state = 'theirs';
    } else if ((m = line.match(CLOSE)) && state === 'theirs') {
      state = 'both';
      theirsLabel ||= m[1] ?? '';
    } else if (state === 'both') {
      ours.push(line);
      theirs.push(line);
      base.push(line);
    } else if (state === 'ours') ours.push(line);
    else if (state === 'base') base.push(line);
    else theirs.push(line);
  }
  if (state !== 'both') throw new Error('A conflict has no end (>>>>>>>).');
  return { ours: ours.join('\n'), theirs: theirs.join('\n'), base: withBase ? base.join('\n') : null, oursLabel, theirsLabel, count };
}

/** A cell as one side has it: its id and its text in the file. */
export interface SideCell {
  id: string;
  text: string;
}

/** A cell in the merged notebook: in both sides the same, in both but different, or in one side only. */
export type MergeCell =
  | { id: string; kind: 'same'; text: string }
  | { id: string; kind: 'differs'; ours: string; theirs: string; base: string | null }
  | { id: string; kind: 'ours-only' | 'theirs-only'; text: string; base: string | null };

/**
 * The cells of the merged notebook, in order: our cells in our order, and a cell only theirs has after the cell
 * before it in their order (at the start when it is their first). `base` gives the common version's cells, when known:
 * a one-sided cell then also says whether the other side removed it (`base` is its old text) or this side added it
 * (`base` null).
 */
export function mergeCells(ours: SideCell[], theirs: SideCell[], base: SideCell[] | null = null): MergeCell[] {
  const theirsById = new Map(theirs.map((c) => [c.id, c.text]));
  const oursIds = new Set(ours.map((c) => c.id));
  const baseById = new Map((base ?? []).map((c) => [c.id, c.text]));
  const out: MergeCell[] = ours.map((c): MergeCell => {
    const t = theirsById.get(c.id);
    if (t === undefined) return { id: c.id, kind: 'ours-only', text: c.text, base: baseById.get(c.id) ?? null };
    return t === c.text ? { id: c.id, kind: 'same', text: c.text } : { id: c.id, kind: 'differs', ours: c.text, theirs: t, base: baseById.get(c.id) ?? null };
  });
  theirs.forEach((c, i) => {
    if (oursIds.has(c.id)) return;
    const prev = theirs.slice(0, i).reverse().find((p) => out.some((o) => o.id === p.id));
    const at = prev ? out.findIndex((o) => o.id === prev.id) + 1 : 0;
    out.splice(at, 0, { id: c.id, kind: 'theirs-only', text: c.text, base: baseById.get(c.id) ?? null });
  });
  return out;
}

/** What to do with a cell that differs (`ours`, `theirs`, or text written by hand) or is one side's only (`keep`, `drop`). */
export type CellChoice = 'ours' | 'theirs' | 'keep' | 'drop' | { text: string };

/** The default choice: one-sided cells are kept; a cell that differs has none until the user makes one. */
export function defaultChoice(cell: MergeCell): CellChoice | null {
  return cell.kind === 'ours-only' || cell.kind === 'theirs-only' ? 'keep' : cell.kind === 'same' ? 'keep' : null;
}

/** The notebook with a choice for each cell, as text: the cells joined by a blank line. Throws when one is missing. */
export function resolveCells(cells: MergeCell[], choices: Record<string, CellChoice | undefined>): string {
  const parts: string[] = [];
  for (const c of cells) {
    const choice = choices[c.id] ?? defaultChoice(c);
    if (choice === null) throw new Error(`Cell "${c.id}" differs: choose ours, theirs or your own text.`);
    if (choice === 'drop') continue;
    let text: string;
    if (typeof choice === 'object') text = choice.text;
    else if (c.kind === 'differs') text = choice === 'theirs' ? c.theirs : c.ours;
    else text = c.text;
    parts.push(text.replace(/\n+$/, ''));
  }
  return parts.join('\n\n') + '\n';
}
