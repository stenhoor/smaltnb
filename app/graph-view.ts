// The graph view: the notebook's cells as boxes, left to right by how deep they sit in the graph, with an arrow for
// each name a cell reads from another (dashed when only its guard reads it). Each box takes its cell's status colour.
// Clicking a box goes to the cell; hovering one brings forward what it reads and what reads it. Notebook-specific UI,
// so it lives here rather than in smaltkit (DESIGN.md decision 20). The setup cell (imports) is left out: every cell
// would point at it.

import type { NotebookView, CellView } from '../src/kernel.js';

const SVG = 'http://www.w3.org/2000/svg';
const W = 156;
const H = 38;
const COL = W + 64;
const ROW = H + 16;
const PAD = 12;

export interface GraphLayout {
  nodes: { id: string; kind: string; x: number; y: number }[];
  edges: { from: string; to: string; names: string[]; guard: boolean }[];
  width: number;
  height: number;
}

/** Places the cells: a column per depth (the longest chain of inputs before a cell), file order within a column. */
export function layoutGraph(nb: NotebookView): GraphLayout {
  const cells = nb.cells.filter((c) => c.kind !== 'setup');
  const ids = new Set(cells.map((c) => c.id));
  const edges = nb.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const depth = new Map<string, number>();
  for (const id of nb.order.filter((i) => ids.has(i))) {
    const ins = edges.filter((e) => e.to === id).map((e) => (depth.get(e.from) ?? -1) + 1);
    depth.set(id, Math.max(0, ...ins));
  }
  const columns = new Map<number, string[]>();
  for (const c of cells) {
    const d = depth.get(c.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), c.id]);
  }
  const nodes = cells.map((c) => {
    const d = depth.get(c.id) ?? 0;
    return { id: c.id, kind: c.kind, x: PAD + d * COL, y: PAD + columns.get(d)!.indexOf(c.id) * ROW };
  });
  const cols = Math.max(1, columns.size ? Math.max(...columns.keys()) + 1 : 1);
  const rows = Math.max(1, ...[...columns.values()].map((c) => c.length));
  return {
    nodes,
    edges: edges.map((e) => ({ from: e.from, to: e.to, names: e.names, guard: e.kind === 'guard' })),
    width: PAD * 2 + (cols - 1) * COL + W,
    height: PAD * 2 + (rows - 1) * ROW + H,
  };
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
}

/** Draws the graph into `host`, replacing what was there. `onPick` is called with a cell's id when its box is clicked. */
export function drawGraph(host: HTMLElement, nb: NotebookView, state: (id: string) => CellView | undefined, onPick: (id: string) => void): void {
  const g = layoutGraph(nb);
  const svg = el('svg', { width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, role: 'img', 'aria-label': 'The notebook\'s cells and what each reads' });
  const defs = el('defs', {}, svg);
  const marker = el('marker', { id: 'nb-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
  el('path', { d: 'M0,0 L8,4 L0,8 z', class: 'arrowhead' }, marker);
  const at = new Map(g.nodes.map((n) => [n.id, n]));
  const edgeEls = g.edges.map((e) => {
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    const [x1, y1, x2, y2] = [a.x + W, a.y + H / 2, b.x, b.y + H / 2];
    const back = x2 <= x1; // a function declaration read from further down
    const d = back
      ? `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
    const path = el('path', { d, class: `edge${e.guard ? ' guard' : ''}`, 'marker-end': 'url(#nb-arrow)', 'data-from': e.from, 'data-to': e.to }, svg);
    el('title', {}, path).textContent = `${e.to} reads ${e.names.join(', ')} from ${e.from}${e.guard ? ' (in its guard)' : ''}`;
    return path;
  });
  for (const n of g.nodes) {
    const s = state(n.id);
    const node = el('g', { class: `node kind-${n.kind}`, transform: `translate(${n.x},${n.y})`, tabindex: 0, role: 'button', 'data-node': n.id, 'data-status': s?.status ?? 'idle' }, svg);
    el('rect', { width: W, height: H, rx: 6 }, node);
    const label = el('text', { x: 12, y: H / 2 + 4 }, node);
    label.textContent = n.id.length > 18 ? `${n.id.slice(0, 17)}…` : n.id;
    if (n.kind === 'action') {
      const tag = el('text', { x: W - 10, y: H / 2 + 4, 'text-anchor': 'end', class: 'tag' }, node);
      tag.textContent = 'action';
    }
    el('title', {}, node).textContent = `${n.id}: ${s?.status ?? 'not run'}${s?.reason ? ` · ${s.reason}` : ''}`;
    const pick = () => onPick(n.id);
    node.addEventListener('click', pick);
    node.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    const linked = (on: boolean) => {
      svg.classList.toggle('focus', on);
      const near = new Set([n.id]);
      for (const p of edgeEls) {
        const hit = p.dataset.from === n.id || p.dataset.to === n.id;
        p.classList.toggle('near', on && hit);
        if (hit) near.add(p.dataset.from!).add(p.dataset.to!);
      }
      for (const other of svg.querySelectorAll<SVGGElement>('g.node')) other.classList.toggle('near', on && near.has(other.dataset.node!));
    };
    node.addEventListener('mouseenter', () => linked(true));
    node.addEventListener('mouseleave', () => linked(false));
    node.addEventListener('focus', () => linked(true));
    node.addEventListener('blur', () => linked(false));
  }
  host.replaceChildren(svg);
}

/** Recolours one cell's box after its state changed, without drawing the graph again. */
export function updateGraphNode(host: HTMLElement, s: CellView): void {
  const node = host.querySelector<SVGGElement>(`g.node[data-node="${CSS.escape(s.id)}"]`);
  if (!node) return;
  node.dataset.status = s.status;
  const title = node.querySelector('title');
  if (title) title.textContent = `${s.id}: ${s.status}${s.reason ? ` · ${s.reason}` : ''}`;
}
