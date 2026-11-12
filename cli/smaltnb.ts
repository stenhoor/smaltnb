#!/usr/bin/env node
// smaltnb run: runs a notebook in Node, from start to end, as a scheduled run does (DESIGN.md, order of work, step 5).
//
//   smaltnb run regional.nb.ts --param mode=full --actions --db data/orders.db --report run.json --md run.md
//
// It needs smaltkit (smaltty reads the TypeScript), smaltdb with smaltql, and smaltdf for frames: smaltnb's optional
// peer dependencies, loaded here when the command runs, so the library itself loads none of them. With --db it also
// needs @smaltworks/smaltdb-node, the plugin that keeps smaltdb's files on disk; without it the database is in memory.
// Exit codes: 0 ok, 1 a cell failed, was held or is stale, 2 the command couldn't run.
//
// This file is the only Node code in the package: src/ stays browser-first.

import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reportJson, reportMarkdown, reportText, runNotebook } from 'smaltnb/report';
import { buildNotebooks } from './build.js';
import type { TypeScriptKit } from 'smaltnb/format';

const USAGE = `Usage: smaltnb run <notebook.nb.ts> [options]
       smaltnb build <notebook.nb.ts>... [--out <dir>]

run: runs every cell in order and prints each one's status. Exits 1 if a cell fails or is held.
build: writes each notebook as a library, <name>.nb.js and <name>.nb.d.ts under --out (default dist), keeping their
folders. The default export is the notebook's factory: notebook.with(params).get(...names).

Options for run:
  --param name=value   Set a parameter (repeat for more). Values are text, checked as in the page.
  --actions            Run the notebook's actions too, once each, in order.
  --db <file>          Keep the database in this file (needs @smaltworks/smaltdb-node). Default: in memory.
  --init <file.sql>    Run this SQL before the notebook, to create or fill tables (repeat for more).
  --report <file>      Write the run as JSON.
  --md <file>          Write the run as Markdown. In GitHub Actions, --md - appends to the job summary.
  --rows <n>           Rows of each table kept in the reports (default 20).
  --quiet              Print only the result line.
  -h, --help           Show this help.
`;

class UsageError extends Error {}

interface Args {
  notebook: string;
  params: Record<string, string>;
  actions: boolean;
  db: string | null;
  init: string[];
  report: string | null;
  md: string | null;
  rows: number;
  quiet: boolean;
}

export function parseArgs(argv: string[]): Args | 'help' {
  if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) return 'help';
  const [command, ...rest] = argv;
  if (command !== 'run') throw new UsageError(`Unknown command "${command}": the commands are "smaltnb run" and "smaltnb build".`);
  const a: Args = { notebook: '', params: {}, actions: false, db: null, init: [], report: null, md: null, rows: 20, quiet: false };
  const value = (i: number, flag: string) => {
    const v = rest[i + 1];
    if (v === undefined || (v.startsWith('--') && v !== '-')) throw new UsageError(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    switch (arg) {
      case '--param': {
        const v = value(i++, arg);
        const eq = v.indexOf('=');
        if (eq < 1) throw new UsageError(`--param needs name=value, not "${v}".`);
        a.params[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      case '--actions': a.actions = true; break;
      case '--quiet': a.quiet = true; break;
      case '--db': a.db = value(i++, arg); break;
      case '--init': a.init.push(value(i++, arg)); break;
      case '--report': a.report = value(i++, arg); break;
      case '--md': a.md = value(i++, arg); break;
      case '--rows': {
        const n = Number(value(i++, arg));
        if (!Number.isInteger(n) || n < 0) throw new UsageError('--rows needs a whole number.');
        a.rows = n;
        break;
      }
      default:
        if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}.`);
        if (a.notebook) throw new UsageError(`One notebook at a time: got "${a.notebook}" and "${arg}".`);
        a.notebook = arg;
    }
  }
  if (!a.notebook) throw new UsageError('Give the notebook to run: smaltnb run <notebook.nb.ts>.');
  return a;
}

type Module = Record<string, any>;

/**
 * Loads a package by the first of its names that is installed (packages are moving to the @smaltworks scope), from
 * the notebook's folder first, then from smaltnb's.
 */
async function load(names: string[], from: string, why: string): Promise<Module> {
  for (const name of names) {
    const m = await tryImport(name, from);
    if (m) return m;
  }
  throw new UsageError(`${why} needs ${names[0]}, which isn't installed. Install it beside smaltnb (npm install ${names[0]}).`);
}

async function tryImport(spec: string, from: string): Promise<Module | null> {
  try {
    return (await import(pathToFileURL(createRequire(resolve(from, 'notebook.js')).resolve(spec)).href)) as Module;
  } catch {
    // not installed beside the notebook: try smaltnb's own
  }
  try {
    return (await import(spec)) as Module;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null;
    throw e;
  }
}

/** smaltnb build <notebook.nb.ts>... [--out dir] */
async function buildCommand(argv: string[], io: { out(s: string): void; err(s: string): void }): Promise<number> {
  const files: string[] = [];
  let out = 'dist';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return usage(io, '--out needs a folder.');
      out = v;
    } else if (argv[i]!.startsWith('-')) return usage(io, `Unknown option ${argv[i]}.`);
    else files.push(argv[i]!);
  }
  if (!files.length) return usage(io, 'Give the notebooks to build: smaltnb build <notebook.nb.ts>...');
  try {
    const ts = (await load(['smaltkit/typescript'], process.cwd(), 'Reading TypeScript')).smaltty as TypeScriptKit;
    const r = buildNotebooks(ts, files, out);
    for (const f of r.written) io.out(`wrote ${f}\n`);
    for (const e of r.errors) io.err(`smaltnb build: ${e}\n`);
    return r.errors.length ? 1 : 0;
  } catch (e) {
    io.err(`smaltnb: ${(e as Error).message}\n`);
    return 2;
  }
}

function usage(io: { err(s: string): void }, message: string): number {
  io.err(`${message}\n\n${USAGE}`);
  return 2;
}

export async function main(argv: string[], io = { out: (s: string) => process.stdout.write(s), err: (s: string) => process.stderr.write(s) }): Promise<number> {
  if (argv[0] === 'build' && !argv.includes('-h') && !argv.includes('--help')) return buildCommand(argv.slice(1), io);
  let args: Args | 'help';
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    io.out(USAGE);
    return 0;
  }
  const a = args;
  try {
    const path = resolve(a.notebook);
    const dir = dirname(path);
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (e) {
      throw new UsageError(`Can't read ${a.notebook}: ${(e as Error).message}`);
    }
    const ts = (await load(['smaltkit/typescript'], dir, 'Reading TypeScript')).smaltty as TypeScriptKit;
    const engine = await load(['smaltdb/engine', '@smaltworks/smaltdb/engine'], dir, 'The database');
    const language = await load(['smaltdb/language', '@smaltworks/smaltdb/language'], dir, 'The database');
    const sql = await load(['@smaltworks/smaltql', 'smaltql'], dir, 'SQL');
    language.registerLanguage(sql.sqlLanguage);
    const df = (await tryImport('@smaltworks/smaltdf', dir)) ?? (await tryImport('@smaltdb/df', dir));
    if (df?.dfLanguage) language.registerLanguage(df.dfLanguage);

    let database: { exec(sql: string): void; close(): void };
    if (a.db) {
      const node = await load(['@smaltworks/smaltdb-node'], dir, '--db (a database in a file)');
      const file = resolve(a.db);
      database = await engine.Database.open(new node.NodeVfs({ root: dirname(file) }), basename(file));
    } else {
      database = engine.Database.openMemory();
    }
    try {
      for (const f of a.init) {
        let text: string;
        try {
          text = readFileSync(resolve(f), 'utf8');
        } catch (e) {
          throw new UsageError(`Can't read ${f}: ${(e as Error).message}`);
        }
        try {
          database.exec(text);
        } catch (e) {
          throw new UsageError(`${f}: ${(e as Error).message}`);
        }
      }
      const report = await runNotebook(source, {
        ts, fileName: basename(path), database, frame: df?.table, params: a.params, actions: a.actions, reportRows: a.rows,
        // Notebooks it imports (./lib.nb.ts), by their path relative to its folder.
        readNotebook: async (p) => readFileSync(resolve(dir, p), 'utf8'),
        // What the notebook imports resolves from its own folder, then from smaltnb's.
        importModule: async (spec) => {
          if (spec.startsWith('.') || spec.startsWith('/')) return (await import(pathToFileURL(resolve(dir, spec)).href)) as Module;
          const m = await tryImport(spec, dir);
          if (!m) throw new Error(`Can't load '${spec}': it isn't installed.`);
          return m;
        },
      });
      if (a.report) writeFileSync(a.report, reportJson(report));
      if (a.md) {
        const md = reportMarkdown(report);
        const summary = process.env.GITHUB_STEP_SUMMARY;
        if (a.md === '-') {
          if (summary) appendFileSync(summary, md);
          else io.out(md);
        } else writeFileSync(a.md, md);
      }
      const text = reportText(report);
      io.out(a.quiet ? text.split('\n').filter(Boolean).at(-1)! + '\n' : text);
      return report.ok ? 0 : 1;
    } finally {
      database.close();
    }
  } catch (e) {
    io.err(`smaltnb: ${(e as Error).message}\n`);
    return 2;
  }
}

// Run as a command (not when a test imports it).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}
