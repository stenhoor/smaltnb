// Runs a notebook from start to end, as a scheduled run does, and reports on it: every cell's status, reason, timing
// and output, and the parameters it ran with. `smaltnb run` (cli/) prints the report, writes it as JSON or Markdown,
// and exits 1 when it isn't ok. Nothing here uses Node: a page could run a notebook the same way.

import { createRuntime, type RuntimeOptions } from './runtime.js';
import { view, type Display } from './kernel.js';
import type { ParamInfo } from './params.js';
import type { CellStatus } from './runtime.js';

export interface RunNotebookOptions extends Omit<RuntimeOptions, 'onChange' | 'onParams'> {
  /** Run the notebook's actions too, once each, in order. Default false: a run that only reads. */
  actions?: boolean;
  /** Rows of each table output kept in the report. Default 20. */
  reportRows?: number;
}

/** A cell's output, as the report keeps it: tables as their first rows, charts as what they draw. */
export type ReportOutput =
  | { kind: 'none' }
  | { kind: 'value'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'table'; columns: string[]; rowCount: number; rows: unknown[][] }
  | { kind: 'chart'; chart: string; columns: string[]; rowCount: number };

export interface CellReport {
  id: string;
  kind: 'setup' | 'cell' | 'action';
  status: CellStatus;
  reason: string | null;
  ms: number | null;
  output: ReportOutput;
}

export interface RunReport {
  /** The notebook's file name. */
  notebook: string;
  /** No cell failed or was held: what a scheduled run checks. */
  ok: boolean;
  /** When the run started, as an ISO time. */
  started: string;
  ms: number;
  /** Whether actions ran. */
  actions: boolean;
  params: ParamInfo[];
  /** Parameter values given that the notebook doesn't declare. */
  unknownParams: string[];
  cells: CellReport[];
  /** Problems in the notebook itself (diagnostics that are errors). */
  errors: string[];
}

/** Runs every cell in order (actions only with `actions: true`) and reports on the run. */
export async function runNotebook(source: string, options: RunNotebookOptions): Promise<RunReport> {
  const started = new Date();
  const t0 = performance.now();
  const keep = options.reportRows ?? 20;
  const rt = createRuntime(source, { ...options, previewRows: Math.max(keep, options.previewRows ?? 0) });
  const kinds = new Map(rt.notebook.cells.map((c) => [c.id, c.kind]));
  const reportOf = (id: string): CellReport => {
    const s = rt.state(id)!;
    const v = view(s);
    return { id, kind: kinds.get(id) ?? 'cell', status: s.status, reason: s.reason, ms: s.ms, output: outputOf(v.output, keep) };
  };
  await rt.runAll({ actions: !!options.actions });
  const cells = rt.notebook.cells.map((c) => reportOf(c.id));
  const params = rt.params();
  const declared = new Set(params.map((p) => p.name));
  const errors = rt.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.cell ? `${d.cell}: ` : ''}${d.message}`);
  return {
    notebook: options.fileName ?? 'notebook.nb.ts',
    ok: errors.length === 0 && cells.every((c) => c.status !== 'error' && c.status !== 'held' && c.status !== 'stale'),
    started: started.toISOString(),
    ms: performance.now() - t0,
    actions: !!options.actions,
    params,
    unknownParams: Object.keys(options.params ?? {}).filter((n) => !declared.has(n)),
    cells,
    errors,
  };
}

function outputOf(d: Display, keep: number): ReportOutput {
  switch (d.kind) {
    case 'table':
      return { kind: 'table', columns: d.table.columns, rowCount: d.table.rowCount, rows: d.preview.rows.slice(0, keep) };
    case 'chart':
      return { kind: 'chart', chart: d.chart.kind, columns: d.chart.columns, rowCount: d.chart.rowCount };
    default:
      return d;
  }
}

/** The report as JSON: bigints as numbers where they fit (else text), bytes as their length. */
export function reportJson(r: RunReport): string {
  return JSON.stringify(r, (_k, v: unknown) => jsonValue(v), 2) + '\n';
}

function jsonValue(v: unknown): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  if (v instanceof Uint8Array) return `[${v.length} bytes]`;
  return v;
}

const MARK: Record<CellStatus, string> = { ok: '✓', error: '✗', held: '!', stale: '~', skipped: '-', idle: '·', running: '…' };

/** The report as lines of text, for a terminal: a line per cell, then the result. */
export function reportText(r: RunReport): string {
  const lines = [`${r.notebook}${r.actions ? ' (with actions)' : ''}`];
  for (const p of r.params) lines.push(`  param ${p.name} = ${p.value}${p.value !== p.default ? ` (default ${p.default})` : ''}${p.error ? `: ${p.error}` : ''}`);
  for (const n of r.unknownParams) lines.push(`  param ${n}: the notebook declares no such parameter`);
  for (const e of r.errors) lines.push(`  error: ${e}`);
  for (const c of r.cells) {
    if (c.kind === 'setup' && c.status === 'ok') continue;
    const what = c.output.kind === 'table' ? `${c.output.rowCount} row${c.output.rowCount === 1 ? '' : 's'}`
      : c.output.kind === 'chart' ? `${c.output.chart} chart of ${c.output.rowCount} row${c.output.rowCount === 1 ? '' : 's'}` : '';
    const status = c.kind === 'action' && c.status === 'idle' && !r.actions ? 'not run: actions run with --actions' : c.status === 'ok' ? null : c.status;
    const detail = [status, c.reason, what || null, c.ms !== null ? ms(c.ms) : null].filter(Boolean).join(' · ');
    lines.push(`  ${MARK[c.status]} ${c.id}${c.kind === 'action' ? ' (action)' : ''}${detail ? `  ${detail}` : ''}`);
  }
  const bad = r.cells.filter((c) => c.status === 'error' || c.status === 'held' || c.status === 'stale').length;
  lines.push(r.ok ? `ok: ${r.cells.length} cells in ${ms(r.ms)}` : `failed: ${bad + r.errors.length} problem${bad + r.errors.length === 1 ? '' : 's'} in ${ms(r.ms)}`);
  return lines.join('\n') + '\n';
}

/**
 * The report as Markdown, for a GitHub Actions job summary or a file: a status table, then each cell's output (text
 * cells as their Markdown, tables as Markdown tables of their first rows).
 */
export function reportMarkdown(r: RunReport): string {
  const out: string[] = [`## ${mdText(r.notebook)}: ${r.ok ? 'ok' : 'failed'}`, ''];
  out.push(`${r.cells.length} cells in ${ms(r.ms)}${r.actions ? ', with actions' : ''}. Started ${r.started}.`, '');
  if (r.params.length) {
    out.push('| Parameter | Value | Default |', '|---|---|---|');
    for (const p of r.params) out.push(`| ${mdCell(p.name)} | ${mdCell(p.value)}${p.error ? ` ✗ ${mdCell(p.error)}` : ''} | ${mdCell(p.default)} |`);
    out.push('');
  }
  for (const e of r.errors) out.push(`- ✗ ${mdText(e)}`);
  if (r.errors.length) out.push('');
  out.push('| | Cell | Status | Time |', '|---|---|---|---|');
  for (const c of r.cells) out.push(`| ${MARK[c.status]} | ${mdCell(c.id)}${c.kind === 'action' ? ' (action)' : ''} | ${mdCell(c.status + (c.reason ? `: ${c.reason}` : ''))} | ${c.ms !== null ? ms(c.ms) : ''} |`);
  out.push('');
  for (const c of r.cells) {
    const o = c.output;
    if (o.kind === 'none' || c.status === 'error') continue;
    out.push(`### ${mdText(c.id)}`, '');
    if (o.kind === 'markdown') out.push(o.text.trim());
    else if (o.kind === 'table') {
      out.push(`| ${o.columns.map(mdCell).join(' | ')} |`, `|${o.columns.map(() => '---').join('|')}|`);
      for (const row of o.rows) out.push(`| ${row.map((v) => mdCell(show(v))).join(' | ')} |`);
      if (o.rowCount > o.rows.length) out.push('', `First ${o.rows.length} of ${o.rowCount} rows.`);
    } else if (o.kind === 'chart') out.push(`A ${o.chart} chart of ${o.columns.map((c) => `\`${c}\``).join(', ')}, ${o.rowCount} rows (drawn in the notebook page).`);
    else out.push('```', o.kind === 'text' ? o.text : show(o.value), '```');
    out.push('');
  }
  return out.join('\n');
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  try {
    return JSON.stringify(v, (_k, x: unknown) => jsonValue(x)) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Text in a Markdown table cell: pipes escaped, one line. */
function mdCell(s: string): string {
  return mdText(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Text that shouldn't become Markdown: HTML and emphasis characters escaped. */
function mdText(s: string): string {
  return s.replace(/[\\`*_<>[\]]/g, (c) => `\\${c}`);
}

function ms(t: number): string {
  return t < 1000 ? `${Math.round(t)} ms` : `${(t / 1000).toFixed(1)} s`;
}
