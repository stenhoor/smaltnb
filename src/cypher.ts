// Cypher in a notebook, run by smaltcy on the notebook's graph: one graph per notebook, in memory, beside its database
// (DESIGN.md decision 24). `cypher` builds a query; the runtime runs it when the cell finishes and collects its rows, as
// it does SQL's, so later cells read the result. `cypher.run` runs a statement at once (an action that writes in steps).
//
// Inside both tags, `${value}` is a parameter (`$p1`, …): a number, a string, a boolean, null, a list or a map of them,
// or another cell's collected result, which becomes its rows as a list of maps (`UNWIND ${orders} AS o CREATE …`).
// Values are never spliced into the text.
//
// A statement that writes (CREATE, MERGE, SET, REMOVE, DELETE, an index) is a write, held in a cell that isn't an
// action (decision 7). `cypher.run` only works inside a running notebook: the runtime supplies it.

/** A query, not yet run: the runtime runs it on the notebook's graph when its cell finishes. */
export class CypherQuery {
  readonly text: string;
  /** The `${}` values, in order: the text names them `$p1`, `$p2`, … */
  readonly values: readonly unknown[];
  constructor(text: string, values: readonly unknown[]) {
    this.text = text;
    this.values = values;
  }
}

/** A value a result holds: what smaltcy returns, with nodes, relationships and paths as plain objects. */
export type GraphValue =
  | null
  | boolean
  | number
  | string
  | readonly GraphValue[]
  | { readonly [key: string]: GraphValue }
  | GraphNode
  | GraphRelationship
  | GraphPath;

export interface GraphNode {
  readonly kind: 'node';
  readonly id: number;
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, GraphValue>>;
}

export interface GraphRelationship {
  readonly kind: 'relationship';
  readonly id: number;
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly properties: Readonly<Record<string, GraphValue>>;
}

export interface GraphPath {
  readonly kind: 'path';
  readonly nodes: readonly GraphNode[];
  readonly relationships: readonly GraphRelationship[];
}

/** What a Cypher statement wrote. */
export interface GraphWrites {
  [what: string]: number;
}

/** A Cypher result: its columns and its rows, each a record by column name. */
export class GraphResult<R extends Record<string, GraphValue> = Record<string, GraphValue>> {
  readonly columns: readonly string[];
  readonly rows: readonly R[];
  /** What the statement wrote: nodes and relationships created and deleted, properties and labels set, … */
  readonly writes: GraphWrites;
  constructor(columns: readonly string[], rows: readonly R[], writes: GraphWrites = {}) {
    this.columns = columns;
    this.rows = rows;
    this.writes = writes;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  /** The nodes and relationships the rows hold (in paths too), each once: what a graph view draws. */
  graph(): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
    const nodes = new Map<number, GraphNode>();
    const rels = new Map<number, GraphRelationship>();
    const visit = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach(visit);
      const o = v as { kind?: unknown };
      if (o.kind === 'node' && typeof (o as GraphNode).id === 'number' && Array.isArray((o as GraphNode).labels)) nodes.set((o as GraphNode).id, o as GraphNode);
      else if (o.kind === 'relationship' && typeof (o as GraphRelationship).start === 'number') rels.set((o as GraphRelationship).id, o as GraphRelationship);
      else if (o.kind === 'path' && Array.isArray((o as GraphPath).nodes)) {
        (o as GraphPath).nodes.forEach(visit);
        (o as GraphPath).relationships.forEach(visit);
      } else for (const x of Object.values(v)) visit(x);
    };
    for (const r of this.rows) for (const c of this.columns) visit(r[c]);
    return { nodes: [...nodes.values()], relationships: [...rels.values()] };
  }
}

interface CypherTag {
  (strings: TemplateStringsArray, ...values: unknown[]): CypherQuery;
  /** Runs a statement at once on the notebook's graph and returns its result. In a cell that isn't an action, a write is held. */
  run(strings: TemplateStringsArray, ...values: unknown[]): Promise<GraphResult>;
}

/** The template's text as written: raw, as SQL's is, with only \\` and \\${ unescaped. */
const rawText = (s: string) => s.replace(/\\(`|\$(?=\{))/g, '$1');

/** @internal Builds a query from a template: the `${}` become `$p1`, `$p2`, … */
export function cypherQuery(strings: TemplateStringsArray, values: unknown[]): CypherQuery {
  const parts = strings.raw.map(rawText);
  let text = parts[0]!;
  values.forEach((v, i) => {
    if (v === undefined) throw new TypeError(`cypher: \${} number ${i + 1} is undefined.`);
    text += `$p${i + 1}` + parts[i + 1]!;
  });
  return new CypherQuery(text, values);
}

const outside = () => Promise.reject(new Error('cypher.run only works inside a running notebook.'));

/** A Cypher query. The runtime runs it on the notebook's graph when the cell finishes, and collects its rows. */
export const cypher: CypherTag = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => cypherQuery(strings, values),
  { run: (strings: TemplateStringsArray, ...values: unknown[]) => { void cypherQuery(strings, values); return outside(); } },
);

/**
 * smaltcy, as the runtime needs it: `open` makes the notebook's graph, `compile` reads a statement's plan without running
 * it (to tell a write). Pass the package itself: `import * as smaltcy from '@smaltworks/smaltcy'`.
 */
export interface GraphEngineModule {
  open(): GraphLike;
  compile(text: string): { plan: unknown };
}

/** What the runtime uses of a smaltcy `Graph`. */
export interface GraphLike {
  run(text: string, params?: Record<string, unknown>): { columns: readonly string[]; rows: readonly (readonly unknown[])[]; counts?: object };
  readonly store: { stats(): { nodes: number; rels: number; labels: ReadonlyMap<string, number>; types: ReadonlyMap<string, number> } };
}

const WRITE_OPS = new Set(['create', 'merge', 'set', 'remove', 'delete']);

/** Whether a smaltcy plan writes: an index plan, or a query with a create, merge, set, remove or delete step. */
export function graphPlanWrites(plan: unknown): boolean {
  if (!plan || typeof plan !== 'object') return false;
  const p = plan as { kind?: unknown; root?: unknown };
  if (p.kind !== 'query') return true;
  const visit = (op: unknown): boolean => {
    if (!op || typeof op !== 'object') return false;
    const o = op as { op?: unknown; input?: unknown; inputs?: unknown };
    if (typeof o.op === 'string' && WRITE_OPS.has(o.op)) return true;
    if (Array.isArray(o.inputs)) return o.inputs.some(visit);
    return visit(o.input);
  };
  return visit(p.root);
}

/** What completion knows about the notebook's graph. */
export interface GraphVocabulary {
  labels: string[];
  types: string[];
  properties: string[];
}
