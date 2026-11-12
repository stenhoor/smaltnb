// Row types for SQL results (DESIGN.md decision 11): what a query's rows look like, as TypeScript, from the column
// types the engine reports. The page offers to pin it in the source (sql<{ region: string; revenue: number }>`…`), and
// warns when a run no longer matches what is pinned. Nothing here runs a query: it reads a collected result's columns.

import type { TypeScriptKit } from './format.js';

/** A column's TypeScript type, from the engine's type for it. An integer is a number; an unknown type is `unknown`. */
export function tsTypeOf(engineType: string | null | undefined): string {
  switch ((engineType ?? '').toLowerCase()) {
    case 'int': case 'integer': case 'real': case 'num': case 'numeric': case 'float': case 'double': return 'number';
    case 'text': return 'string';
    case 'bool': case 'boolean': return 'boolean';
    case 'blob': return 'Uint8Array';
    case 'null': return 'null';
    default: return 'unknown';
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A property name as TypeScript writes it: bare when it can be, else quoted. */
function propertyName(name: string): string {
  return IDENT.test(name) ? name : `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The row type of a result with these columns: `{ region: string; revenue: number }`. */
export function rowTypeOf(columns: readonly string[], columnTypes: readonly (string | null | undefined)[]): string {
  if (!columns.length) return '{}';
  return `{ ${columns.map((c, i) => `${propertyName(c)}: ${tsTypeOf(columnTypes[i])}`).join('; ')} }`;
}

/** What the page shows about a query cell's row type, after a run. */
export interface RowTypeInfo {
  /** The type the last run's columns give. */
  inferred: string;
  /** The type pinned in the source (`sql<…>`), or null. */
  pinned: string | null;
  /** Why the pinned type no longer matches the run, or null when it does (or can't be checked: a named type). */
  mismatch: string | null;
}

/**
 * Checks a pinned row type against a result's columns: the same names, and for each column a type that takes the
 * run's (a pinned `number | null` takes `number`; `unknown` takes anything). A named type (`sql<Order>`) isn't checked:
 * its members are elsewhere.
 */
export function checkRowType(ts: TypeScriptKit, pinned: string, columns: readonly string[], columnTypes: readonly (string | null | undefined)[]): string | null {
  const t = ts.parse(`type __Row = ${pinned};`, { fileName: 'row.ts' });
  const alias = t.children(t.root)[0];
  const literal = alias === undefined ? undefined : t.children(alias).find((c) => t.kind[c] === ts.K.TypeLiteral);
  if (literal === undefined) return null;
  const members = new Map<string, string>();
  for (const m of t.children(literal)) {
    if (t.kind[m] !== ts.K.PropertySignature) continue;
    const [key, type] = t.children(m);
    if (key === undefined) continue;
    const raw = t.textOf(key);
    const name = t.kind[key] === ts.K.StringLiteral ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
    members.set(name, type === undefined ? 'any' : t.textOf(type));
  }
  const problems: string[] = [];
  const missing = columns.filter((c) => !members.has(c));
  const extra = [...members.keys()].filter((m) => !columns.includes(m));
  if (missing.length) problems.push(`the result has ${missing.map((c) => `"${c}"`).join(', ')}, which the type doesn't`);
  if (extra.length) problems.push(`the type has ${extra.map((c) => `"${c}"`).join(', ')}, which the result doesn't`);
  columns.forEach((c, i) => {
    const pinnedType = members.get(c);
    const want = tsTypeOf(columnTypes[i]);
    if (pinnedType === undefined || want === 'unknown' || want === 'null') return;
    const parts = pinnedType.split('|').map((p) => p.trim());
    if (parts.some((p) => p === want || p === 'unknown' || p === 'any' || (want === 'number' && p === 'bigint'))) return;
    problems.push(`"${c}" is ${want} in the result, ${pinnedType} in the type`);
  });
  return problems.length ? `${problems.join('; ')}.` : null;
}
