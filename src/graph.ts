// The notebook's dependency graph: which cells read what other cells define, the order they run in, and what a change
// means for the cells downstream of it. Built from a parsed notebook (./format.js); nothing here runs code.
//
// Edges come from names (TypeScript) and, in a later step, from tables (the plans' read and write sets).

import type { Cell, Diagnostic, Notebook } from './format.js';

/** `value`: the cell reads the name in its code. `guard`: only its `when` guard reads it. */
export type EdgeKind = 'value' | 'guard';

export interface Edge {
  from: string;
  to: string;
  names: string[];
  kind: EdgeKind;
}

export interface Graph {
  cells: Cell[];
  byId: Map<string, Cell>;
  edges: Edge[];
  /** Cell ids in run order: file order whenever the notebook reads top to bottom. */
  order: string[];
  /** The notebook's diagnostics and the graph's own (cycles, exports that need an action). */
  diagnostics: Diagnostic[];
}

/** Builds the graph of a parsed notebook. */
export function buildGraph(notebook: Notebook): Graph {
  const cells = notebook.cells;
  const byId = new Map(cells.map((c) => [c.id, c]));
  const owner = new Map<string, string>();
  for (const c of cells) for (const n of c.defines) if (!owner.has(n)) owner.set(n, c.id);

  const edges: Edge[] = [];
  const add = (to: Cell, names: string[], kind: EdgeKind) => {
    const byFrom = new Map<string, string[]>();
    for (const n of names) {
      const from = owner.get(n);
      if (!from || from === to.id) continue;
      byFrom.set(from, [...(byFrom.get(from) ?? []), n]);
    }
    for (const [from, ns] of byFrom) edges.push({ from, to: to.id, names: ns, kind });
  };
  for (const c of cells) {
    add(c, c.reads, 'value');
    if (c.when) add(c, c.when.reads.filter((n) => !c.reads.includes(n)), 'guard');
  }

  const diagnostics = [...notebook.diagnostics];
  const order = topoOrder(cells, edges, diagnostics);
  const graph: Graph = { cells, byId, edges, order, diagnostics };

  // An export may not depend on an action: importing a notebook never runs its actions.
  for (const c of cells) {
    if (!c.exports.length) continue;
    if (c.kind === 'action') {
      diagnostics.push({
        severity: 'error', code: 'export-from-action', cell: c.id,
        message: `Action "${c.id}" exports ${c.exports.join(', ')}. Importing a notebook never runs its actions, so they cannot export.`,
      });
      continue;
    }
    const action = upstream(graph, [c.id]).find((id) => byId.get(id)!.kind === 'action');
    if (action) {
      diagnostics.push({
        severity: 'error', code: 'export-needs-action', cell: c.id,
        message: `${c.exports.join(', ')} depend${c.exports.length === 1 ? 's' : ''} on action "${action}". Importing a notebook never runs its actions, so an export cannot depend on one.`,
      });
    }
  }
  return graph;
}

/** Kahn's algorithm, taking cells in file order whenever more than one is ready. Cells on a cycle go last. */
function topoOrder(cells: Cell[], edges: Edge[], diagnostics: Diagnostic[]): string[] {
  const indegree = new Map(cells.map((c) => [c.id, 0]));
  for (const e of edges) indegree.set(e.to, indegree.get(e.to)! + 1);
  const order: string[] = [];
  const done = new Set<string>();
  for (;;) {
    const next = cells.find((c) => !done.has(c.id) && indegree.get(c.id) === 0);
    if (!next) break;
    done.add(next.id);
    order.push(next.id);
    for (const e of edges) if (e.from === next.id) indegree.set(e.to, indegree.get(e.to)! - 1);
  }
  const stuck = cells.filter((c) => !done.has(c.id)).map((c) => c.id);
  if (stuck.length) {
    diagnostics.push({
      severity: 'error', code: 'cycle', cell: stuck[0]!,
      message: `Cells ${stuck.map((id) => `"${id}"`).join(', ')} depend on each other in a cycle, so none of them can run first.`,
    });
    order.push(...stuck);
  }
  return order;
}

function walk(graph: Graph, start: string[], next: (id: string) => string[]): string[] {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    for (const n of next(stack.pop()!)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  }
  for (const s of start) seen.delete(s);
  return graph.order.filter((id) => seen.has(id));
}

/** The cells the given cells depend on, directly or not, in run order (excluding the given cells). */
export function upstream(graph: Graph, ids: string[]): string[] {
  return walk(graph, ids, (id) => graph.edges.filter((e) => e.to === id).map((e) => e.from));
}

/** The cells that depend on the given cells, directly or not, in run order (excluding the given cells). */
export function downstream(graph: Graph, ids: string[]): string[] {
  return walk(graph, ids, (id) => graph.edges.filter((e) => e.from === id).map((e) => e.to));
}

export interface ExportClosure {
  /** The cells to evaluate, in run order: the cells defining the names and everything they depend on. */
  cells: string[];
  /** Requested names the notebook does not export. */
  missing: string[];
}

/** What importing these exports needs: only those cells, never the whole notebook. */
export function exportClosure(graph: Graph, names: string[]): ExportClosure {
  const owners = new Set<string>();
  const missing: string[] = [];
  for (const n of names) {
    const c = graph.cells.find((cell) => cell.exports.includes(n));
    if (c) owners.add(c.id);
    else missing.push(n);
  }
  const needed = new Set([...owners, ...upstream(graph, [...owners])]);
  return { cells: graph.order.filter((id) => needed.has(id)), missing };
}

export interface PropagateOptions {
  /** Cells run on request (a Run button): they run whatever their run mode, and count as run for what follows. */
  run?: string[];
}

export interface Propagation {
  /** Cells to run now, in run order. */
  run: string[];
  /** Cells whose results are now out of date and wait to be run. */
  stale: string[];
}

/**
 * What a change to some cells means: the changed cells and everything downstream of them, split into what runs now
 * and what goes stale. An `auto` cell runs when everything it depends on that changed also runs; a `lazy` or
 * `manual` cell, or an action, goes stale, and so does everything downstream of a stale cell. Guards are evaluated
 * when cells run, not here.
 */
export function propagate(graph: Graph, changed: string[], options: PropagateOptions = {}): Propagation {
  const forced = new Set(options.run ?? []);
  const start = [...new Set([...changed, ...forced])];
  const affected = new Set([...start, ...downstream(graph, start)]);
  const state = new Map<string, 'run' | 'stale'>();
  for (const id of graph.order) {
    if (!affected.has(id)) continue;
    const cell = graph.byId.get(id)!;
    const inputs = graph.edges.filter((e) => e.to === id && affected.has(e.from)).map((e) => state.get(e.from));
    const ready = forced.has(id) || cell.kind !== 'action' && cell.run === 'auto' && inputs.every((s) => s === 'run');
    state.set(id, ready ? 'run' : 'stale');
  }
  const pick = (s: 'run' | 'stale') => graph.order.filter((id) => state.get(id) === s);
  return { run: pick('run'), stale: pick('stale') };
}
