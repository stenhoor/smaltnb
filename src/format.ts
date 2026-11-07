// Reads a .nb.ts notebook: splits it into cells at its top-level `cell()` and `action()` statements, reads their
// options, and finds which top-level names each cell defines, reads and exports. Names are resolved with the
// TypeScript compiler, so shadowing, property names and type positions are handled as TypeScript sees them.
//
// The compiler is passed in, not imported: in a page it is loaded at run time (like the engine), in Node it is the
// `typescript` package. Nothing here runs the notebook.

import type * as TS from 'typescript';
import type { CellLang, ResultStore, RunMode } from './notebook.js';

export type TypeScript = typeof TS;

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
export function parseNotebook(source: string, ts: TypeScript, options: ParseOptions = {}): Notebook {
  const fileName = options.fileName ?? 'notebook.nb.ts';
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const checker = checkerFor(ts, sf);
  const diagnostics: Diagnostic[] = [];

  const span = (start: number, end: number): Span => ({
    start,
    end,
    line: sf.getLineAndCharacterOfPosition(start).line + 1,
    endLine: sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1,
  });
  const nodeSpan = (node: TS.Node) => span(node.getStart(sf), node.getEnd());
  const report = (severity: Severity, code: string, message: string, node?: TS.Node, cell?: string) =>
    diagnostics.push({ severity, code, message, ...(cell !== undefined && { cell }), ...(node && { span: nodeSpan(node) }) });

  // The local names `cell` and `action` are imported under (`import { cell as c } from 'smaltnb'` works too).
  const markers = new Map<string, 'cell' | 'action'>();
  // sql and exec imported from smaltnb under their own names: what a plain SQL cell is written with.
  const sqlTags = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== MODULE) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === 'cell' || imported === 'action') markers.set(el.name.text, imported);
      if ((imported === 'sql' || imported === 'exec') && el.name.text === imported) sqlTags.add(imported);
    }
  }
  const markerOf = (st: TS.Statement): { kind: 'cell' | 'action'; call: TS.CallExpression } | null => {
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) return null;
    const callee = st.expression.expression;
    const kind = ts.isIdentifier(callee) ? markers.get(callee.text) : undefined;
    return kind ? { kind, call: st.expression } : null;
  };

  // Group statements: setup, then one group per marker.
  interface Group { kind: CellKind; marker: TS.ExpressionStatement | null; call: TS.CallExpression | null; statements: TS.Statement[] }
  const groups: Group[] = [{ kind: 'setup', marker: null, call: null, statements: [] }];
  for (const st of sf.statements) {
    const m = markerOf(st);
    if (m) groups.push({ kind: m.kind, marker: st as TS.ExpressionStatement, call: m.call, statements: [] });
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
      const [nameArg, optsArg, ...rest] = g.call.arguments;
      if (nameArg && (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg)) && nameArg.text.trim()) {
        id = nameArg.text;
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
    const first = g.marker ?? g.statements[0];
    const last = g.statements[g.statements.length - 1] ?? g.marker;
    cell.span = first && last ? span(first.getStart(sf), last.getEnd()) : span(0, 0);
    if (g.statements.length) cell.body = span(g.statements[0]!.getStart(sf), last!.getEnd());
    const tail = g.statements[g.statements.length - 1];
    if (tail && ts.isExpressionStatement(tail)) cell.output = nodeSpan(tail.expression);
    const next = groups[index + 1]?.marker;
    cell.sql = sqlViewOf(g.kind, g.statements, cell, g.marker ? g.marker.getEnd() : 0, next ? next.getStart(sf) : source.length);
    cells.push(cell);

    function readOptions(arg: TS.Expression, allowed: string[]) {
      if (!ts.isObjectLiteralExpression(arg)) {
        report('error', 'cell-options', `${g.kind}() options must be an object literal, so they can be read without running the notebook.`, arg, id);
        return;
      }
      for (const prop of arg.properties) {
        const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : undefined;
        if (!key || !allowed.includes(key)) {
          const hint = g.kind === 'action' && key && CELL_OPTIONS.includes(key) ? ' An action never reruns on its own, so it has no run mode or result store.' : '';
          report('error', 'cell-options', `Unknown ${g.kind}() option${key ? ` "${key}"` : ''}. Allowed: ${allowed.join(', ')}.${hint}`, prop, id);
          continue;
        }
        const value = ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
        if (key === 'when') {
          if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) cell.when = { text: value.getText(sf), reads: [] };
          else report('error', 'cell-options', 'when must be a function, e.g. when: () => params.mode === \'full\'.', prop, id);
          continue;
        }
        if (key === 'live' || key === 'hide') {
          if (value && (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)) cell[key] = value.kind === ts.SyntaxKind.TrueKeyword;
          else report('error', 'cell-options', `${key} must be true or false.`, prop, id);
          continue;
        }
        const allowedValues: readonly string[] = key === 'lang' ? LANGS : key === 'run' ? RUN_MODES : STORES;
        if (value && ts.isStringLiteral(value) && allowedValues.includes(value.text)) {
          if (key === 'lang') cell.lang = value.text as CellLang;
          else if (key === 'run') cell.run = value.text as RunMode;
          else cell.store = value.text as ResultStore;
        } else {
          report('error', 'cell-options', `${key} must be one of ${allowedValues.map((v) => `'${v}'`).join(', ')}.`, prop, id);
        }
      }
    }
  });

  // Top-level declarations, by symbol.
  const declared = new Map<TS.Symbol, Declared>();
  const declare = (nameNode: TS.Node, cellIndex: number, hoisted: boolean, typeOnly: boolean, exported: boolean) => {
    const sym = checker.getSymbolAtLocation(nameNode);
    const name = nameNode.getText(sf);
    const cell = cells[cellIndex]!;
    if (sym) declared.set(sym, { cell: cellIndex, name, hoisted, typeOnly });
    if (!cell.defines.includes(name)) cell.defines.push(name);
    if (typeOnly && !cell.typeDefines.includes(name)) cell.typeDefines.push(name);
    if (exported && !cell.exports.includes(name)) cell.exports.push(name);
  };
  const bindingNames = (name: TS.BindingName, out: TS.Identifier[] = []): TS.Identifier[] => {
    if (ts.isIdentifier(name)) out.push(name);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
    return out;
  };
  const isExported = (st: TS.Statement) =>
    ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (st: TS.Statement) =>
    ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  groups.forEach((g, i) => {
    const id = cells[i]!.id;
    for (const st of g.statements) {
      if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st)) {
        if (g.kind !== 'setup') report('error', 'import-in-cell', 'Imports belong before the first cell, in the setup cell.', st, id);
        if (ts.isImportDeclaration(st)) {
          const clause = st.importClause;
          if (clause?.name) declare(clause.name, i, false, !!clause.isTypeOnly, false);
          const nb = clause?.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) declare(nb.name, i, false, !!clause?.isTypeOnly, false);
          if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) declare(el.name, i, false, !!clause?.isTypeOnly || el.isTypeOnly, false);
        } else {
          declare(st.name, i, false, false, false);
        }
        continue;
      }
      if (g.kind === 'setup') {
        report('error', 'setup-code', 'Only imports may come before the first cell(). Start a cell for this code.', st, id);
      }
      const exported = isExported(st);
      if (exported && isDefault(st) || ts.isExportAssignment(st)) {
        report('error', 'export-default', 'A notebook\'s default export is its typed factory, so cells cannot export default.', st, id);
        continue;
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) for (const n of bindingNames(d.name)) declare(n, i, false, false, exported);
      } else if (ts.isFunctionDeclaration(st) && st.name) {
        declare(st.name, i, true, false, exported);
      } else if ((ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
        declare(st.name, i, false, false, exported);
      } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
        declare(st.name, i, false, true, exported);
      } else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) {
        declare(st.name, i, false, false, exported);
      } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const name = (el.propertyName ?? el.name).getText(sf);
          if (!cells[i]!.exports.includes(name)) cells[i]!.exports.push(name);
        }
      } else if (ts.isExportDeclaration(st)) {
        report('error', 'export-from', 'Re-exports from another module belong in a plain module, not a notebook.', st, id);
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
  const isTypePosition = (node: TS.Node): boolean => {
    for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isExpressionWithTypeArguments(p)) {
        const h = p.parent;
        return !(ts.isHeritageClause(h) && h.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(h.parent));
      }
      if (ts.isTypeNode(p)) return true;
      if (ts.isStatement(p)) return false;
    }
    return false;
  };
  const isAssignmentTarget = (id: TS.Identifier): boolean => {
    const p = id.parent;
    if (ts.isBinaryExpression(p) && p.left === id) {
      return p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    }
    if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
    return false;
  };

  groups.forEach((g, i) => {
    const cell = cells[i]!;
    const reads = new Set<string>();
    const typeReads = new Set<string>();
    const visit = (node: TS.Node, into: Set<string>, guard: boolean) => {
      let sym: TS.Symbol | undefined;
      let target: TS.Identifier | undefined;
      if (ts.isShorthandPropertyAssignment(node)) {
        sym = checker.getShorthandAssignmentValueSymbol(node);
        target = node.name;
      } else if (ts.isIdentifier(node) && !ts.isShorthandPropertyAssignment(node.parent) && !ts.isExportSpecifier(node.parent)) {
        sym = checker.getSymbolAtLocation(node);
        target = node;
      }
      const d = sym && declared.get(sym);
      if (d && target && d.cell !== i) {
        const typeUse = d.typeOnly || isTypePosition(target);
        if (typeUse) typeReads.add(d.name);
        else {
          into.add(d.name);
          if (d.cell > i && !d.hoisted) {
            report('error', 'defined-later', `"${d.name}" is defined further down, in cell "${cells[d.cell]!.id}". A notebook reads top to bottom: move this cell below it.`, target, cell.id);
          }
          if (!guard && isAssignmentTarget(target)) {
            report('error', 'assign-elsewhere', `"${d.name}" is defined in cell "${cells[d.cell]!.id}" and may be assigned only there.`, target, cell.id);
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, into, guard));
    };
    for (const st of g.statements) visit(st, reads, false);
    if (g.call && cell.when) {
      const guardFn = (g.call.arguments[1] as TS.ObjectLiteralExpression).properties
        .find((p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'when')!.initializer;
      const guardReads = new Set<string>();
      visit(guardFn, guardReads, true);
      cell.when.reads = [...guardReads];
    }
    cell.reads = [...reads];
    cell.typeReads = [...typeReads].filter((n) => !reads.has(n));
  });

  return { fileName, cells, diagnostics };

  /** The cell as plain SQL, if its code is exactly what `sqlBody` writes for it (so nothing is lost writing it back). */
  function sqlViewOf(kind: CellKind, sts: TS.Statement[], cell: Cell, from: number, to: number): SqlView | null {
    if (cell.lang !== 'sql' || kind === 'setup') return null;
    const sqlOf = (e: TS.Expression, tag: 'sql' | 'exec') => {
      if (!ts.isTaggedTemplateExpression(e) || !ts.isIdentifier(e.tag) || e.tag.text !== tag || !sqlTags.has(tag)) return null;
      return { text: e.template.getText(sf).slice(1, -1).replace(/\\`/g, '`'), type: e.typeArguments?.[0]?.getText(sf) ?? null, args: e.typeArguments?.length ?? 0 };
    };
    let view: SqlView | null = null;
    if (kind === 'cell') {
      const [decl, show, ...rest] = sts;
      if (!decl || rest.length || !ts.isVariableStatement(decl) || !(decl.declarationList.flags & ts.NodeFlags.Const)) return null;
      const d = decl.declarationList.declarations;
      if (d.length !== 1 || !ts.isIdentifier(d[0]!.name) || d[0]!.name.text !== cell.id || !d[0]!.initializer || d[0]!.type) return null;
      const q = sqlOf(d[0]!.initializer, 'sql');
      if (!q || q.args > 1) return null;
      if (show && !(ts.isExpressionStatement(show) && ts.isIdentifier(show.expression) && show.expression.text === cell.id)) return null;
      const exported = (ts.getModifiers(decl) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      view = { kind: 'query', name: cell.id, exported, rowType: q.type, text: q.text, output: !!show };
    } else {
      const statements: string[] = [];
      for (const st of sts) {
        const e = ts.isExpressionStatement(st) && ts.isAwaitExpression(st.expression) ? sqlOf(st.expression.expression, 'exec') : null;
        if (!e || e.args) return null;
        statements.push(e.text);
      }
      view = { kind: 'script', statements };
    }
    // Everything from the cell() line to the next cell must be what sqlBody writes: a comment or extra code anywhere in
    // it keeps the cell TypeScript, since the SQL view would hide it.
    const strip = (t: string) => t.replace(/\s+/g, '');
    return strip(source.slice(from, to)) === strip(sqlBody(view)) ? view : null;
  }
}

/** A type checker over the one file, with no lib and no module resolution: enough to resolve the file's own names. */
function checkerFor(ts: TypeScript, sf: TS.SourceFile): TS.TypeChecker {
  const host: TS.CompilerHost = {
    getSourceFile: (name) => (name === sf.fileName ? sf : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\n',
    fileExists: (name) => name === sf.fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram([sf.fileName], {
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  }, host);
  return program.getTypeChecker();
}
