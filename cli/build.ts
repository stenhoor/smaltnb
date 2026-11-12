// smaltnb build: notebooks as compiled libraries (DESIGN.md decision 14). For each notebook it writes, under --out,
//
//   orders.nb.js     its factory as the default export: orders.with({ minQty: 2 }).get('orders')
//   orders.nb.d.ts   the factory's types, taken from the notebook's own source (a type-only import of it)
//
// keeping the notebooks' folders, from their common folder. The .js embeds the notebook's source and reads it with
// smaltty when it runs, so it needs smaltnb and smaltkit beside it, not TypeScript. A notebook that imports another by
// name (./orders.nb.ts) is built with it, and the built one imports the other's built module.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseNotebook, moduleOf, type TypeScriptKit } from 'smaltnb/format';
import { isNotebookImport, resolveNotebookPath } from 'smaltnb/runtime';

export interface BuildResult {
  /** Files written, relative to the working directory. */
  written: string[];
  /** Problems that stopped a notebook from being built. */
  errors: string[];
}

/** A path with `/` between its parts, as notebooks and imports write them. */
const posix = (p: string) => p.split(sep).join('/');

/** `./x` for a path in the same folder, as an import needs. */
const dotted = (p: string) => (p.startsWith('.') ? p : `./${p}`);

/** The folder every file is in. */
function commonDir(files: string[]): string {
  let dir = dirname(files[0]!);
  while (!files.every((f) => f === dir || f.startsWith(dir.endsWith(sep) ? dir : dir + sep))) dir = dirname(dir);
  return dir;
}

/** The notebook's imports of other notebooks: their specifiers as written. */
function notebookImports(ts: TypeScriptKit, source: string, fileName: string): string[] {
  const t = ts.parse(source, { fileName });
  const specs: string[] = [];
  for (const st of t.children(t.root)) {
    if (t.kind[st] !== ts.K.ImportDeclaration) continue;
    const spec = moduleOf(t, ts, st);
    if (isNotebookImport(spec)) specs.push(spec);
  }
  return specs;
}

/** Builds these notebooks into `out`. */
export function buildNotebooks(ts: TypeScriptKit, files: string[], out: string): BuildResult {
  const paths = files.map((f) => resolve(f));
  const root = commonDir(paths);
  const outDir = resolve(out);
  const built = new Set(paths.map((p) => posix(relative(root, p))));
  const result: BuildResult = { written: [], errors: [] };
  for (const path of paths) {
    const name = posix(relative(root, path)); // e.g. lib/orders.nb.ts: the notebook's fileName, and its key
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (e) {
      result.errors.push(`${name}: ${(e as Error).message}`);
      continue;
    }
    const errors = parseNotebook(source, ts, { fileName: name }).diagnostics.filter((d) => d.severity === 'error');
    if (errors.length) {
      result.errors.push(...errors.map((d) => `${name}${d.cell ? ` (${d.cell})` : ''}: ${d.message}`));
      continue;
    }
    const imports = notebookImports(ts, source, name).map((spec) => resolveNotebookPath(name, spec));
    const missing = imports.filter((p) => !built.has(p));
    if (missing.length) {
      result.errors.push(`${name} imports ${missing.join(', ')}: build it in the same command.`);
      continue;
    }
    const js = join(outDir, name.replace(/\.ts$/, '.js'));
    const dts = join(outDir, name.replace(/\.ts$/, '.d.ts'));
    const here = dirname(js);
    const notebooks = imports.map((p) => `    ${JSON.stringify(p)}: () => import(${JSON.stringify(dotted(posix(relative(here, join(outDir, p.replace(/\.ts$/, '.js'))))))}),`);
    mkdirSync(here, { recursive: true });
    writeFileSync(js, [
      `// Built by smaltnb build from ${name}: don't edit. Its default export is the notebook's factory:`,
      `// .with(params).get(...names) runs what those exports need. See "Notebooks as libraries" in smaltnb's guide.`,
      `import { notebookFactory } from 'smaltnb/library';`,
      `import { smaltty } from 'smaltkit/typescript';`,
      ``,
      `export default notebookFactory({`,
      `  fileName: ${JSON.stringify(name)},`,
      `  source: ${JSON.stringify(source)},`,
      `  ts: smaltty,`,
      `  // What the notebook imports, from this module's folder.`,
      `  importModule: (spec) => import(spec),`,
      `  notebooks: {`,
      ...notebooks,
      `  },`,
      `});`,
      ``,
    ].join('\n'));
    writeFileSync(dts, [
      `// Built by smaltnb build from ${name}: don't edit. The notebook's factory, typed from its source.`,
      `import type { NotebookFactory } from 'smaltnb/library';`,
      `import type * as source from ${JSON.stringify(dotted(posix(relative(here, path))))};`,
      ``,
      `declare const notebook: NotebookFactory<typeof source>;`,
      `export default notebook;`,
      ``,
    ].join('\n'));
    result.written.push(posix(relative(process.cwd(), js)), posix(relative(process.cwd(), dts)));
  }
  return result;
}
