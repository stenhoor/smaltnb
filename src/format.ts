// Reads a .nb.ts notebook: splits it into cells at its top-level `cell()` and `action()` statements, reads their
// options, and finds which top-level names each cell defines, reads and exports. It works on smaltty's syntax tree and
// binder (TypeScript's own tree and scoping rules), so shadowing, property names and type positions are handled as
// TypeScript sees them.
//
// smaltty is passed in, not imported (`smaltty` from smaltkit/typescript), so this module loads without a bundler.
// Nothing here runs the notebook.

import type { smaltty } from 'smaltkit/typescript';
import type { CellLang, ResultStore, RunMode } from './notebook.js';

/** smaltty, the TypeScript kit: `smaltty` from smaltkit/typescript. */
export type TypeScriptKit = typeof smaltty;
type Tree = ReturnType<TypeScriptKit['parse']>;

/** A range of the source: offsets (0-based, end exclusive) and lines (1-based, inclusive). */
export interface Span {
  start: number;
  end: number;
  line: number;
  endLine: number;
}

export type CellKind = 'setup' | 'cell' | 'action';

export interface CellGuard {
  /** The guard's source, e.g. `() => params.mode === 'full'`. */
  text: string;
  /** Top-level names of other cells the guard reads. */
  reads: string[];
}

export interface Cell {
  /** The cell's name, unique in the notebook; `setup` for the code before the first cell. */
  id: string;
  kind: CellKind;
  lang: CellLang;
  run: RunMode;
  store: ResultStore;
  live: boolean;
  hide: boolean;
  when: CellGuard | null;
  /** The whole cell, from its `cell()` or `action()` statement to the next one. */
  span: Span;
  /** The cell's code after its `cell()` or `action()` statement; null when it has none. */
  body: Span | null;
  /** Top-level names this cell declares, values and types. */
  defines: string[];
  /** The subset of `defines` that exists only as a type (interfaces, type aliases, type-only imports). */
  typeDefines: string[];
  /** The subset of `defines` that is exported. */
  exports: string[];
  /** Top-level names of other cells this cell reads at run time. */
  reads: string[];
  /** Top-level names of other cells this cell uses only as types: they matter to the compiler, not to a run. */
  typeReads: string[];
  /** The cell's last expression statement, shown as its output; null when the cell does not end with one. */
  output: Span | null;
  /**
   * A plain SQL cell (`lang: 'sql'` holding only SQL), as its SQL: what an editor shows instead of the TypeScript.
   * Null when the cell holds anything more. `sqlBody(view)` writes the code back.
   */
  sql: SqlView | null;
}

/**
 * A plain SQL cell's content.
 * - `query`: a cell `name` that is `[export] const name = sql<Row>`…`;`, optionally followed by `name;` (show it).
 * - `script`: an action whose code is only `await exec`…`;` statements.
 * `text` and `statements` are the SQL as written, with `${…}` references kept.
 */
export type SqlView =
  | { kind: 'query'; name: string; exported: boolean; rowType: string | null; text: string; output: boolean }
  | { kind: 'script'; statements: string[] };

/** Escapes SQL for a template literal: only a backtick needs it (`${…}` stays a reference). */
export function escapeTemplate(sql: string): string {
  return sql.replace(/`/g, '\\`');
}

/** A plain SQL cell's code, after its cell() or action() line. */
export function sqlBody(view: SqlView): string {
  if (view.kind === 'query') {
    const type = view.rowType ? `<${view.rowType}>` : '';
    return `${view.exported ? 'export ' : ''}const ${view.name} = sql${type}\`${escapeTemplate(view.text)}\`;`
      + (view.output ? `\n${view.name};` : '');
  }
  return view.statements.map((st) => `await exec\`${escapeTemplate(st)}\`;`).join('\n');
}

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /** A stable code, e.g. `defined-later`. */
  code: string;
  message: string;
  /** The cell the diagnostic is about. */
  cell?: string;
  span?: Span;
}

export interface Notebook {
  fileName: string;
  cells: Cell[];
  diagnostics: Diagnostic[];
}

export interface ParseOptions {
  /** Used in spans and messages. Default: `notebook.nb.ts`. */
  fileName?: string;
}

const MODULE = 'smaltnb';
const LANGS: readonly CellLang[] = ['ts', 'sql', 'df', 'md'];
const RUN_MODES: readonly RunMode[] = ['auto', 'lazy', 'manual'];
const STORES: readonly ResultStore[] = ['memory', 'opfs'];
const CELL_OPTIONS = ['lang', 'run', 'when', 'store', 'live', 'hide'];
const ACTION_OPTIONS = ['lang', 'when', 'hide'];

interface Declared {
  cell: number;
  name: string;
  /** A function declaration: hoisted, so it may be read before the cell that defines it. */
  hoisted: boolean;
  /** Only a type (interface, type alias): never needed at run time. */
  typeOnly: boolean;
}

/** Splits a notebook into cells and reads what each defines, reads and exports. */
export function parseNotebook(source: string, ts: TypeScriptKit, options: ParseOptions = {}): Notebook {
  const fileName = options.fileName ?? 'notebook.nb.ts';
  const { K, F } = ts;
  const diagnostics: Diagnostic[] = [];
  // Line starts, for spans.
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const span = (start: number, end: number): Span => ({ start, end, line: lineOf(start), endLine: lineOf(Math.max(start, end - 1)) });

  // A syntax error doesn't lose the notebook: the cell it is in is blanked out and reported, and the rest is read.
  const { tree, broken } = parseTolerant(ts, source, fileName);
  const t = tree;
  const b = ts.bind(t);
  const nodeSpan = (n: number) => span(t.start[n]!, t.end[n]!);
  const report = (severity: Severity, code: string, message: string, node?: number, cell?: string) =>
    diagnostics.push({ severity, code, message, ...(cell !== undefined && { cell }), ...(node && { span: nodeSpan(node) }) });
  const text = (n: number) => t.textOf(n);
  const children = (n: number) => t.children(n);
  const kind = (n: number) => t.kind[n]!;
  const statements = children(t.root);

  // The local names `cell` and `action` are imported under (`import { cell as c } from 'smaltnb'` works too).
  const markers = new Map<string, 'cell' | 'action'>();
  // sql and exec imported from smaltnb under their own names: what a plain SQL cell is written with.
  const sqlTags = new Set<string>();
  for (const st of statements) {
    if (kind(st) !== K.ImportDeclaration || moduleOf(t, ts, st) !== MODULE) continue;
    for (const spec of importSpecifiers(t, ts, st)) {
      const imported = spec.imported;
      if (imported === 'cell' || imported === 'action') markers.set(spec.local, imported);
      if ((imported === 'sql' || imported === 'exec') && spec.local === imported) sqlTags.add(imported);
    }
  }
  const markerOf = (st: number): { kind: 'cell' | 'action'; call: number } | null => {
    if (kind(st) !== K.ExpressionStatement) return null;
    const call = t.first[st]!;
    if (kind(call) !== K.CallExpression) return null;
    const callee = t.first[call]!;
    const k = kind(callee) === K.Identifier ? markers.get(text(callee)) : undefined;
    return k ? { kind: k, call } : null;
  };

  // Group statements: setup, then one group per marker.
  interface Group { kind: CellKind; marker: number; call: number; statements: number[] }
  const groups: Group[] = [{ kind: 'setup', marker: 0, call: 0, statements: [] }];
  for (const st of statements) {
    const m = markerOf(st);
    if (m) groups.push({ kind: m.kind, marker: st, call: m.call, statements: [] });
    else groups[groups.length - 1]!.statements.push(st);
  }
  if (markers.size === 0) report('warning', 'no-cells', `Nothing is imported as cell or action from '${MODULE}', so the notebook has no cells.`);

  // Cells with their options.
  const cells: Cell[] = [];
  const seen = new Set<string>();
  groups.forEach((g, index) => {
    let id = 'setup';
    const cell: Cell = {
      id, kind: g.kind, lang: 'ts', run: 'auto', store: 'memory', live: false, hide: false, when: null,
      span: span(0, 0), body: null, defines: [], typeDefines: [], exports: [], reads: [], typeReads: [], output: null, sql: null,
    };
    if (g.call) {
      const args = callArguments(t, ts, g.call);
      const [nameArg, optsArg, ...rest] = args;
      const name = nameArg !== undefined ? literalString(t, ts, nameArg) : null;
      if (name !== null && name.trim()) {
        id = name;
      } else {
        id = `cell ${index}`;
        report('error', 'cell-name', `A ${g.kind}() needs a name as a string literal as its first argument.`, g.call, id);
      }
      if (rest.length) report('error', 'cell-arguments', `${g.kind}() takes a name and an options object.`, rest[0], id);
      if (optsArg) readOptions(optsArg, g.kind === 'action' ? ACTION_OPTIONS : CELL_OPTIONS);
      if (seen.has(id)) report('error', 'duplicate-name', `Two cells are named "${id}". Cell names must be unique.`, nameArg ?? g.call, id);
      seen.add(id);
    }
    cell.id = id;
    const first = g.marker || g.statements[0];
    const last = g.statements[g.statements.length - 1] ?? g.marker;
    cell.span = first && last ? span(t.start[first]!, t.end[last]!) : span(0, 0);
    if (g.statements.length) cell.body = span(t.start[g.statements[0]!]!, t.end[last!]!);
    const tail = g.statements[g.statements.length - 1];
    if (tail && kind(tail) === K.ExpressionStatement) cell.output = nodeSpan(t.first[tail]!);
    const next = groups[index + 1]?.marker;
    cell.sql = sqlViewOf(g.kind, g.statements, cell, g.marker ? t.end[g.marker]! : 0, next ? t.start[next]! : source.length);
    cells.push(cell);

    function readOptions(arg: number, allowed: string[]) {
      if (kind(arg) !== K.ObjectLiteralExpression) {
        report('error', 'cell-options', `${g.kind}() options must be an object literal, so they can be read without running the notebook.`, arg, id);
        return;
      }
      for (const prop of children(arg)) {
        const pk = kind(prop);
        const nameNode = pk === K.PropertyAssignment || pk === K.ShorthandPropertyAssignment || pk === K.MethodDeclaration ? t.first[prop]! : 0;
        const key = nameNode ? keyText(t, ts, nameNode) ?? undefined : undefined;
        if (!key || !allowed.includes(key)) {
          const hint = g.kind === 'action' && key && CELL_OPTIONS.includes(key) ? ' An action never reruns on its own, so it has no run mode or result store.' : '';
          report('error', 'cell-options', `Unknown ${g.kind}() option${key ? ` "${key}"` : ''}. Allowed: ${allowed.join(', ')}.${hint}`, prop, id);
          continue;
        }
        const value = pk === K.PropertyAssignment ? t.next[t.first[prop]!]! : 0;
        if (key === 'when') {
          if (value && (kind(value) === K.ArrowFunction || kind(value) === K.FunctionExpression)) cell.when = { text: text(value), reads: [] };
          else report('error', 'cell-options', 'when must be a function, e.g. when: () => params.mode === \'full\'.', prop, id);
          continue;
        }
        if (key === 'live' || key === 'hide') {
          if (value && (kind(value) === K.TrueKeyword || kind(value) === K.FalseKeyword)) cell[key] = kind(value) === K.TrueKeyword;
          else report('error', 'cell-options', `${key} must be true or false.`, prop, id);
          continue;
        }
        const allowedValues: readonly string[] = key === 'lang' ? LANGS : key === 'run' ? RUN_MODES : STORES;
        const v = value && kind(value) === K.StringLiteral ? literalString(t, ts, value) : null;
        if (v !== null && allowedValues.includes(v)) {
          if (key === 'lang') cell.lang = v as CellLang;
          else if (key === 'run') cell.run = v as RunMode;
          else cell.store = v as ResultStore;
        } else {
          report('error', 'cell-options', `${key} must be one of ${allowedValues.map((x) => `'${x}'`).join(', ')}.`, prop, id);
        }
      }
    }
  });

  // Syntax errors: on the cell whose code was blanked out.
  for (const e of broken) {
    const owner = cells.find((c) => c.span.start <= e.start && e.start <= c.span.end && c.kind !== 'setup') ??
      cells.find((c) => c.kind === 'setup' && e.start < (cells[1]?.span.start ?? source.length));
    diagnostics.push({ severity: 'error', code: 'syntax', message: e.message, ...(owner && { cell: owner.id }), span: span(e.pos, e.pos) });
  }

  // Top-level declarations, by symbol.
  const declared = new Map<number, Declared>();
  const declare = (nameNode: number, cellIndex: number, hoisted: boolean, typeOnly: boolean, exported: boolean) => {
    const sym = b.symbolOf[nameNode]!;
    const name = text(nameNode);
    const cell = cells[cellIndex]!;
    if (sym) declared.set(sym, { cell: cellIndex, name, hoisted, typeOnly });
    if (!cell.defines.includes(name)) cell.defines.push(name);
    if (typeOnly && !cell.typeDefines.includes(name)) cell.typeDefines.push(name);
    if (exported && !cell.exports.includes(name)) cell.exports.push(name);
  };
  const bindingNames = (name: number, out: number[] = []): number[] => {
    const k = kind(name);
    if (k === K.Identifier) out.push(name);
    else if (k === K.ObjectBindingPattern || k === K.ArrayBindingPattern) {
      for (const el of children(name)) {
        if (kind(el) !== K.BindingElement) continue;
        let n = t.first[el]!;
        if (t.flags[el]! & F.PropertyName) n = t.next[n]!;
        bindingNames(n, out);
      }
    }
    return out;
  };

  groups.forEach((g, i) => {
    const id = cells[i]!.id;
    for (const st of g.statements) {
      const k = kind(st);
      const flags = t.flags[st]!;
      if (k === K.ImportDeclaration || k === K.ImportEqualsDeclaration) {
        if (g.kind !== 'setup') report('error', 'import-in-cell', 'Imports belong before the first cell, in the setup cell.', st, id);
        if (k === K.ImportDeclaration) {
          for (const spec of importSpecifiers(t, ts, st)) declare(spec.node, i, false, spec.typeOnly, false);
        } else {
          declare(t.first[st]!, i, false, false, false);
        }
        continue;
      }
      if (g.kind === 'setup') {
        report('error', 'setup-code', 'Only imports may come before the first cell(). Start a cell for this code.', st, id);
      }
      const exported = !!(flags & F.Export);
      if ((exported && flags & F.Default) || k === K.ExportAssignment) {
        report('error', 'export-default', 'A notebook\'s default export is its typed factory, so cells cannot export default.', st, id);
        continue;
      }
      if (k === K.VariableStatement) {
        for (const d of children(t.first[st]!)) for (const n of bindingNames(t.first[d]!)) declare(n, i, false, false, exported);
      } else if (k === K.FunctionDeclaration && kind(t.first[st]!) === K.Identifier) {
        declare(t.first[st]!, i, true, false, exported);
      } else if ((k === K.ClassDeclaration || k === K.EnumDeclaration) && kind(t.first[st]!) === K.Identifier) {
        declare(t.first[st]!, i, false, false, exported);
      } else if (k === K.InterfaceDeclaration || k === K.TypeAliasDeclaration) {
        declare(t.first[st]!, i, false, true, exported);
      } else if (k === K.ModuleDeclaration && kind(t.first[st]!) === K.Identifier) {
        declare(t.first[st]!, i, false, false, exported);
      } else if (k === K.ExportDeclaration) {
        const clause = children(st).find((c) => kind(c) === K.NamedExports);
        const from = children(st).some((c) => kind(c) === K.StringLiteral);
        if (clause && !from) {
          for (const el of children(clause)) {
            const name = text(t.first[el]!);
            if (!cells[i]!.exports.includes(name)) cells[i]!.exports.push(name);
          }
        } else {
          report('error', 'export-from', 'Re-exports from another module belong in a plain module, not a notebook.', st, id);
        }
      }
    }
  });

  // Exports listed with `export { a }` name bindings that may live in other cells: attribute them to the defining cell.
  for (const c of cells) {
    for (const name of [...c.exports]) {
      if (c.defines.includes(name)) continue;
      const owner = cells.find((o) => o.defines.includes(name));
      c.exports.splice(c.exports.indexOf(name), 1);
      if (owner) {
        if (!owner.exports.includes(name)) owner.exports.push(name);
      } else {
        report('error', 'export-unknown', `"${name}" is exported but not defined in this notebook.`, undefined, c.id);
      }
    }
  }

  // Reads, guard reads and assignments.
  // A name used as a type (`o: Order`, `typeof x` in a type, `implements I`) matters to the compiler, not to a run.
  // `class A extends B` reads B at run time.
  const parent = b.parent;
  const isTypePosition = (node: number): boolean => {
    for (let p = parent[node]!; p; p = parent[p]!) {
      const pk = kind(p);
      if (pk === K.ExpressionWithTypeArguments) {
        const h = parent[p]!;
        const owner = parent[h]!;
        const classExtends = kind(h) === K.HeritageClause && source.startsWith('extends', t.start[h]!) &&
          (kind(owner) === K.ClassDeclaration || kind(owner) === K.ClassExpression);
        return !classExtends;
      }
      if (ts.isTypeNode(pk)) return true;
      if (isStatementKind(ts, pk)) return false;
    }
    return false;
  };
  const isAssignmentTarget = (id: number): boolean => {
    const p = parent[id]!;
    const pk = kind(p);
    if (pk === K.BinaryExpression && t.first[p] === id) {
      // The operator is the text between the two operands.
      const between = source.slice(t.end[id]!, t.start[t.next[id]!]!);
      return /^\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)/.test(between);
    }
    if (pk === K.PrefixUnaryExpression || pk === K.PostfixUnaryExpression) return /^\s*(?:\+\+|--)|(?:\+\+|--)\s*$/.test(text(p));
    return false;
  };

  groups.forEach((g, i) => {
    const cell = cells[i]!;
    const reads = new Set<string>();
    const typeReads = new Set<string>();
    const visit = (node: number, into: Set<string>, guard: boolean): void => {
      const k = kind(node);
      if (k === K.Identifier && kind(parent[node]!) !== K.ExportSpecifier) {
        const sym = b.symbolOf[node]!;
        const d = sym ? declared.get(sym) : undefined;
        if (d && d.cell !== i && b.meaningOf[node]) {
          const typeUse = d.typeOnly || isTypePosition(node);
          if (typeUse) typeReads.add(d.name);
          else {
            into.add(d.name);
            if (d.cell > i && !d.hoisted) {
              report('error', 'defined-later', `"${d.name}" is defined further down, in cell "${cells[d.cell]!.id}". A notebook reads top to bottom: move this cell below it.`, node, cell.id);
            }
            if (!guard && isAssignmentTarget(node)) {
              report('error', 'assign-elsewhere', `"${d.name}" is defined in cell "${cells[d.cell]!.id}" and may be assigned only there.`, node, cell.id);
            }
          }
        }
      }
      for (let c = t.first[node]!; c; c = t.next[c]!) visit(c, into, guard);
    };
    for (const st of g.statements) visit(st, reads, false);
    if (g.call && cell.when) {
      const opts = callArguments(t, ts, g.call)[1]!;
      const prop = children(opts).find((p) => kind(p) === K.PropertyAssignment && keyText(t, ts, t.first[p]!) === 'when');
      if (prop) {
        const guardReads = new Set<string>();
        visit(t.next[t.first[prop]!]!, guardReads, true);
        cell.when.reads = [...guardReads];
      }
    }
    cell.reads = [...reads];
    cell.typeReads = [...typeReads].filter((n) => !reads.has(n));
  });

  return { fileName, cells, diagnostics };

  /** The cell as plain SQL, if its code is exactly what `sqlBody` writes for it (so nothing is lost writing it back). */
  function sqlViewOf(kind_: CellKind, sts: number[], cell: Cell, from: number, to: number): SqlView | null {
    if (cell.lang !== 'sql' || kind_ === 'setup') return null;
    const sqlOf = (e: number, tag: 'sql' | 'exec') => {
      if (kind(e) !== K.TaggedTemplateExpression) return null;
      const parts = children(e);
      const tagNode = parts[0]!;
      if (kind(tagNode) !== K.Identifier || text(tagNode) !== tag || !sqlTags.has(tag)) return null;
      const template = parts[parts.length - 1]!;
      const typeArgs = parts.slice(1, -1);
      return { text: text(template).slice(1, -1).replace(/\\`/g, '`'), type: typeArgs[0] ? text(typeArgs[0]) : null, args: typeArgs.length };
    };
    let view: SqlView | null = null;
    if (kind_ === 'cell') {
      const [decl, show, ...rest] = sts;
      if (!decl || rest.length || kind(decl) !== K.VariableStatement) return null;
      const list = t.first[decl]!;
      if (!(t.flags[list]! & F.Const)) return null;
      const d = children(list);
      if (d.length !== 1) return null;
      const [nameNode, ...after] = children(d[0]!);
      if (!nameNode || kind(nameNode) !== K.Identifier || text(nameNode) !== cell.id || after.length !== 1 || ts.isTypeNode(kind(after[0]!))) return null;
      const q = sqlOf(after[0]!, 'sql');
      if (!q || q.args > 1) return null;
      if (show && !(kind(show) === K.ExpressionStatement && kind(t.first[show]!) === K.Identifier && text(t.first[show]!) === cell.id)) return null;
      const exported = !!(t.flags[decl]! & F.Export);
      view = { kind: 'query', name: cell.id, exported, rowType: q.type, text: q.text, output: !!show };
    } else {
      const statements: string[] = [];
      for (const st of sts) {
        const e = kind(st) === K.ExpressionStatement && kind(t.first[st]!) === K.AwaitExpression ? sqlOf(t.first[t.first[st]!]!, 'exec') : null;
        if (!e || e.args) return null;
        statements.push(e.text);
      }
      view = { kind: 'script', statements };
    }
    // Everything from the cell() line to the next cell must be what sqlBody writes: a comment or extra code anywhere in
    // it keeps the cell TypeScript, since the SQL view would hide it.
    const squeeze = (s: string) => s.replace(/\s+/g, '');
    return squeeze(source.slice(from, to)) === squeeze(sqlBody(view)) ? view : null;
  }
}

/** A string literal's value (`'a'`, `"a"` or a template without substitutions), or null for anything else. */
function literalString(t: Tree, ts: TypeScriptKit, n: number): string | null {
  const k = t.kind[n]!;
  if (k !== ts.K.StringLiteral && k !== ts.K.NoSubstitutionTemplateLiteral) return null;
  const raw = t.textOf(n).slice(1, -1);
  if (!raw.includes('\\')) return raw;
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_m, e: string) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
    if (e === '\n' || e === '\r\n' || e === '\r') return '';
    return simple[e] ?? e;
  });
}

/** A property name's text: an identifier, or a string literal's value. */
function keyText(t: Tree, ts: TypeScriptKit, n: number): string | null {
  return t.kind[n] === ts.K.Identifier ? t.textOf(n) : literalString(t, ts, n);
}

/** A call's arguments: its children after the callee and any type arguments. */
function callArguments(t: Tree, ts: TypeScriptKit, call: number): number[] {
  return t.children(call).slice(1).filter((c) => !ts.isTypeNode(t.kind[c]!));
}

/** An import declaration's module name, unquoted. */
export function moduleOf(t: Tree, ts: TypeScriptKit, decl: number): string {
  for (let c = t.first[decl]!; c; c = t.next[c]!) if (t.kind[c] === ts.K.StringLiteral) return literalString(t, ts, c) ?? '';
  return '';
}

export interface ImportedName {
  /** The local name's node. */
  node: number;
  local: string;
  /** The name in the module: `default` for a default import, `*` for a namespace import. */
  imported: string;
  typeOnly: boolean;
}

/** The names an import declaration binds. */
export function importSpecifiers(t: Tree, ts: TypeScriptKit, decl: number): ImportedName[] {
  const { K, F } = ts;
  const out: ImportedName[] = [];
  const clause = t.children(decl).find((c) => t.kind[c] === K.ImportClause);
  if (!clause) return out;
  const clauseTypeOnly = !!(t.flags[clause]! & F.TypeOnly);
  for (const c of t.children(clause)) {
    const k = t.kind[c]!;
    if (k === K.Identifier) out.push({ node: c, local: t.textOf(c), imported: 'default', typeOnly: clauseTypeOnly });
    else if (k === K.NamespaceImport) out.push({ node: t.first[c]!, local: t.textOf(t.first[c]!), imported: '*', typeOnly: clauseTypeOnly });
    else if (k === K.NamedImports) {
      for (const spec of t.children(c)) {
        const parts = t.children(spec);
        const local = parts[parts.length - 1]!;
        const imported = keyText(t, ts, parts[0]!) ?? t.textOf(parts[0]!);
        out.push({ node: local, local: t.textOf(local), imported, typeOnly: clauseTypeOnly || !!(t.flags[spec]! & F.TypeOnly) });
      }
    }
  }
  return out;
}

function isStatementKind(ts: TypeScriptKit, k: number): boolean {
  const { K } = ts;
  return k === K.ExpressionStatement || k === K.VariableStatement || k === K.ReturnStatement || k === K.IfStatement ||
    k === K.Block || k === K.ForStatement || k === K.ForOfStatement || k === K.ForInStatement || k === K.WhileStatement ||
    k === K.DoStatement || k === K.ThrowStatement || k === K.TryStatement || k === K.SwitchStatement ||
    k === K.LabeledStatement || k === K.FunctionDeclaration || k === K.ClassDeclaration;
}

/** A syntax error, and the part of the source blanked out to read the rest. */
interface Broken {
  start: number;
  end: number;
  /** Where the error is. */
  pos: number;
  message: string;
}

/**
 * Parses a notebook that may have syntax errors. smaltty stops at the first error, so a notebook with one is cut into
 * chunks at its cell() and action() lines; each chunk that doesn't parse on its own has its code blanked out (its line
 * breaks kept, so positions don't move), and the rest is parsed. The blanked chunks are reported, and their cells run
 * nothing until the error is fixed.
 */
function parseTolerant(ts: TypeScriptKit, source: string, fileName: string): { tree: Tree; broken: Broken[] } {
  try {
    return { tree: ts.parse(source, { fileName }), broken: [] };
  } catch (e) {
    if (!(e instanceof ts.ParseError)) throw e;
  }
  const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');
  const chunks = chunksOf(source);
  const broken: Broken[] = [];
  let text = source;
  for (const [start, end] of chunks) {
    // The chunk alone, everything else blanked: positions stay those of the source.
    const alone = blank(source.slice(0, start)) + source.slice(start, end) + blank(source.slice(end));
    try {
      ts.parse(alone, { fileName });
    } catch (e) {
      if (!(e instanceof ts.ParseError)) throw e;
      // Keep the cell() line itself when it parses, so the cell stays; blank its code.
      const markerEnd = markerStatementEnd(ts, source, start, end);
      const from = markerEnd ?? start;
      text = text.slice(0, from) + blank(text.slice(from, end)) + text.slice(end);
      broken.push({ start: from, end, pos: e.pos, message: e.message });
    }
  }
  try {
    return { tree: ts.parse(text, { fileName }), broken };
  } catch (e) {
    if (!(e instanceof ts.ParseError)) throw e;
    // An error no chunk has alone (a bracket opened in one cell and closed in another): nothing is read.
    return { tree: ts.parse('', { fileName }), broken: [{ start: 0, end: source.length, pos: e.pos, message: e.message }] };
  }
}

/** The source cut at the lines that start a cell or an action: [start, end) of the setup and of each cell. */
function chunksOf(source: string): [number, number][] {
  const starts = [0];
  const marker = /^(?:cell|action|[A-Za-z_$][\w$]*)\s*\(\s*['"`]/gm;
  // The names cell() and action() are imported under; by default themselves.
  const names = new Set(['cell', 'action']);
  const imp = /import\s*\{([^}]*)\}\s*from\s*['"]smaltnb['"]/.exec(source);
  if (imp) for (const part of imp[1]!.split(',')) {
    const m = /^\s*(cell|action)\s+as\s+([\w$]+)\s*$/.exec(part);
    if (m) names.add(m[2]!);
  }
  for (const m of source.matchAll(marker)) {
    const name = /^[\w$]+/.exec(m[0])![0];
    if (names.has(name) && m.index! > 0) starts.push(m.index!);
  }
  return starts.map((s, i) => [s, starts[i + 1] ?? source.length]);
}

/**
 * Where the cell() or action() statement at the start of a chunk ends (after its `)` and any `;`), if it parses alone;
 * null otherwise. Its brackets are matched, skipping strings, templates and comments, so code after it on the same line
 * is not part of it.
 */
function markerStatementEnd(ts: TypeScriptKit, source: string, start: number, end: number): number | null {
  if (start === 0) return null; // the setup chunk has no marker
  let i = source.indexOf('(', start);
  if (i < 0 || i >= end) return null;
  let depth = 0;
  for (; i < end; i++) {
    const c = source[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) break;
    } else if (c === '"' || c === "'" || c === '`') {
      for (i++; i < end && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return null;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      if (i <= 0) return null;
    }
  }
  if (depth !== 0 || i >= end) return null;
  let stop = i + 1;
  const semicolon = /^[ \t]*;/.exec(source.slice(stop, end));
  if (semicolon) stop += semicolon[0].length;
  try {
    const tree = ts.parse(source.slice(start, stop));
    const first = tree.first[tree.root]!;
    return first && !tree.next[first] && tree.kind[first] === ts.K.ExpressionStatement ? stop : null;
  } catch {
    return null;
  }
}
