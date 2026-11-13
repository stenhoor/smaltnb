// The notebook page: one editor per cell over the notebook's source, run by the kernel worker. The source is the
// .nb.ts text; each cell's editor holds the slice from its cell() line to the next, so joining them gives the file back.
// A plain SQL cell shows only its SQL, and is written back in its TypeScript form (sqlBody); a toggle shows the
// TypeScript, and Source shows the whole file.
import { Editor, typescriptLanguage } from 'smaltkit/editor';
import { splitStatements } from 'smaltkit/sql';
import { exportRows, Grid, type GridRow } from 'smaltkit/grid';
import { download, fileName, pickFile, toast } from 'smaltkit/dom';
import { KernelClient } from '../src/client.js';
import type { CellView, NotebookView } from '../src/kernel.js';
import type { ParamInfo } from '../src/params.js';
import { sqlBody, type SqlView } from '../src/format.js';
import { sqlCellLanguage } from './sql-language.js';
import { markdownLanguage } from './md-language.js';
import { markdown } from 'smaltkit/markdown';
import { drawGraph, updateGraphNode } from './graph-view.js';
import { canOpenFolders, pickFolder, rememberFolder, rememberedFolder, requestAccess, RepoFolder } from './repo-folder.js';
import { diffLines, type GitCommit } from 'smaltkit/git';
import { blameLines, cellChanges, type CellChange } from '../src/history.js';
import { conflictSides, defaultChoice, hasConflictMarkers, mergeCells, resolveCells, type CellChoice, type MergeCell, type SideCell } from '../src/conflicts.js';
import { choiceControl } from 'smaltkit/controls';
import type { ControlInfo } from '../src/ui.js';
import { areaChart, barChart, chartData, columnChart, donutChart, lineChart, pieChart, scatterChart, type ChartColumn, type ChartContext } from 'smaltkit/charts';
import type { ChartOutput } from '../src/chart.js';
import { typeCheckWorker, type TypeCheckWorker, type TypeWarning } from 'smaltkit/typecheck';

const STORE = 'smaltnb:source';
const NAME = 'smaltnb:name';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const cellsEl = $('#cells');
const diagEl = $('#diagnostics');
const nameEl = $<HTMLInputElement>('#name');
const paramsEl = $<HTMLFormElement>('#params');

interface CellUi {
  id: string;
  root: HTMLElement;
  /** "new" or "changed" since the last commit, in a repository folder. */
  change: HTMLElement;
  /** The cell's diff against the last commit, when shown. */
  diff: HTMLElement;
  /** The cell's history in git, when shown. */
  history: HTMLElement;
  editor: Editor;
  status: HTMLElement;
  reason: HTMLElement;
  actions: HTMLElement;
  output: HTMLElement;
  /** The cell's controls (ui.*), between its code and its output. */
  controls: HTMLElement;
  /** The controls last drawn, so a state change that keeps them doesn't redraw (and lose focus). */
  controlsDrawn: string;
  grid: Grid | null;
  /** Stops redrawing the chart when the cell's width changes. */
  unobserve: (() => void) | null;
  /** The output last drawn, so a state change that keeps it doesn't redraw the grid. */
  drawn: string;
  /** The cell's text in the source, from its editor: the TypeScript as typed, or the SQL in its TypeScript form. */
  text(): string;
}

let source = '';
let chunks: { id: string; text: string; start: number }[] = [];
/** Plain SQL cells shown as TypeScript, by id. */
const showTs = new Set<string>();
/** The whole file in one editor. */
let sourceView = false;
let sourceEditor: Editor | null = null;
let ui = new Map<string, CellUi>();
let notebook: NotebookView | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

const kernel = new KernelClient(
  () => new Worker(new URL('./kernel-worker.js', import.meta.url), { type: 'module', name: 'kernel' }),
  { onState: (s) => showState(s), onNotebook: (nb) => onNotebook(nb), onParams: (p) => showParams(p) },
);

/** Splits the source at each cell's first line: the text before the first cell is setup. */
function split(src: string, nb: NotebookView): { id: string; text: string; start: number }[] {
  const starts = nb.cells.map((c) => (c.kind === 'setup' ? 0 : src.lastIndexOf('\n', c.span.start - 1) + 1));
  return nb.cells.map((c, i) => ({ id: c.id, start: starts[i]!, text: src.slice(starts[i]!, i + 1 < starts.length ? starts[i + 1]! : src.length) }));
}

/** What a plain SQL cell's editor shows: the query, or an action's statements, each ending in a semicolon. */
function sqlText(view: SqlView): string {
  if (view.kind === 'md') return view.text.trim();
  return view.kind === 'query' ? view.text.trim() : view.statements.map((st) => `${st.trim()};`).join('\n\n');
}

/** A plain SQL cell's view with the SQL from its editor. */
function withSql(view: SqlView, text: string): SqlView {
  if (view.kind === 'md') return { kind: 'md', text };
  return view.kind === 'query'
    ? { ...view, text }
    : { kind: 'script', statements: splitStatements(text).map((st) => st.sql) };
}

function rowTypeOf(view: SqlView | null | undefined): string | null {
  return view?.kind === 'query' ? view.rowType : null;
}

// The graph view: open or closed is remembered in this browser.
const GRAPH = 'smaltnb:graph';
const graphEl = $('#graph-panel');
const graphButton = $<HTMLButtonElement>('#graph');
let graphOpen = false;
try {
  graphOpen = localStorage.getItem(GRAPH) === '1';
} catch {
  // Storage blocked: the graph starts closed.
}

function showGraph() {
  graphEl.hidden = !graphOpen;
  graphButton.setAttribute('aria-pressed', String(graphOpen));
  if (!graphOpen || !notebook) return;
  drawGraph(graphEl, notebook, (id) => kernel.state(id), (id) => {
    const c = ui.get(id);
    if (!c) return;
    c.editor.focus();
    c.root.scrollIntoView({ block: 'start' }); // after focus, which scrolls too; scroll-margin keeps it below the bar
  });
}

graphButton.addEventListener('click', () => {
  graphOpen = !graphOpen;
  try {
    localStorage.setItem(GRAPH, graphOpen ? '1' : '0');
  } catch {
    // Storage blocked: not remembered.
  }
  showGraph();
});

/** Draw the cells again on the next notebook message: a cell's text was replaced (Use this version). */
let forceRender = false;

function onNotebook(nb: NotebookView) {
  const before = notebook;
  notebook = nb;
  const next = split(source, nb);
  // Redraw when the cells change, or when a cell starts or stops being plain SQL.
  const same = next.length === chunks.length && next.every((c, i) => c.id === chunks[i]!.id
    && !!before?.cells[i]?.sql === !!nb.cells[i]?.sql
    // A pinned row type changed (Pin types): the SQL view writes the cell back with the new one.
    && rowTypeOf(before?.cells[i]?.sql) === rowTypeOf(nb.cells[i]?.sql));
  chunks = next;
  if ((!same || forceRender) && !sourceView) render();
  forceRender = false;
  showDiagnostics(nb);
  showGraph();
  typeCheck();
}

// Type checking (smaltkit/typecheck: smaltty's checker in a worker): the notebook's calls into smaltnb and smaltdf,
// checked against their declarations (types.json, written by scripts/build-app.mjs). Errors are warnings, marked in
// the cells' editors; the notebook still runs. Where the worker can't start, there are no warnings.
let checker: Promise<TypeCheckWorker | null> | null = null;
const loadChecker = () =>
  (checker ??= fetch(new URL('./types.json', import.meta.url))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`types.json: ${r.status}`))))
    .then((setup) => typeCheckWorker(setup, { workerUrl: new URL('./typecheck-worker.js', import.meta.url) }))
    .catch(() => null));

/** Checks the notebook, and marks each warning in the editor showing its code, if the source is still the same. */
function typeCheck() {
  const code = currentSource();
  loadChecker()
    .then((c) => c?.check(code))
    .then((warnings) => {
      if (!warnings || currentSource() !== code) return;
      showWarnings(warnings);
      document.body.dataset.checked = code; // for the tests: the source whose warnings are shown
    })
    .catch(() => {});
}

/** Gives each cell the warnings in its slice of the source; a cell showing its SQL or Markdown has none marked. */
function showWarnings(warnings: TypeWarning[]) {
  if (sourceEditor) return sourceEditor.setWarnings(warnings);
  let at = 0;
  for (const c of ui.values()) {
    const text = c.text().replace(/\n+$/, '');
    const own = c.editor.value === text ? warnings.filter((w) => w.start >= at && w.end <= at + text.length) : [];
    c.editor.setWarnings(own.map((w) => ({ ...w, start: w.start - at, end: w.end - at })));
    at += text.length + 2; // cells are joined by a blank line
  }
}

/** The params bar: one control per parameter. A change reruns what reads it and goes into the page's URL. */
function showParams(params: ParamInfo[]) {
  paramsEl.hidden = params.length === 0;
  const title = document.createElement('span');
  title.className = 'params-title';
  title.textContent = 'Parameters';
  paramsEl.replaceChildren(title, ...params.map((p) => {
    const label = document.createElement('label');
    label.append(p.name);
    let input: HTMLInputElement | HTMLSelectElement;
    if (p.kind === 'choice') {
      input = document.createElement('select');
      for (const c of p.choices ?? []) input.append(new Option(c, c, false, c === p.value));
    } else {
      input = document.createElement('input');
      input.type = p.kind === 'number' ? 'number' : p.kind === 'isoDate' ? 'date' : p.kind === 'bool' ? 'checkbox' : 'text';
      if (p.kind === 'bool') input.checked = p.value === 'true';
      else input.value = p.value;
      if (p.kind === 'number') input.step = 'any';
    }
    input.name = p.name;
    input.title = p.error ?? `Default: ${p.default}`;
    if (p.error) input.classList.add('bad');
    input.addEventListener('change', () => {
      const value = input instanceof HTMLInputElement && input.type === 'checkbox' ? String(input.checked) : input.value;
      void setParam(p.name, value === p.default ? null : value);
    });
    label.append(input);
    return label;
  }));
}

async function setParam(name: string, value: string | null) {
  const url = new URL(location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  history.replaceState(null, '', url);
  await flush();
  await kernel.setParams({ [name]: value }).catch((err: Error) => toast(err.message, 'error'));
}

function showDiagnostics(nb: NotebookView) {
  diagEl.replaceChildren(...nb.diagnostics.map((d) => {
    const li = document.createElement('li');
    li.className = d.severity;
    li.textContent = `${d.cell ? `${d.cell}: ` : ''}${d.message}`;
    return li;
  }));
  diagEl.hidden = nb.diagnostics.length === 0;
}

/** Draws every cell. Keeps the focused cell's editor focused. */
function render() {
  if (sourceView) return renderSource();
  sourceEditor = null;
  const focusedId = [...ui.values()].find((c) => c.root.contains(document.activeElement))?.id;
  for (const c of ui.values()) { c.grid?.destroy(); c.unobserve?.(); }
  ui = new Map();
  cellsEl.replaceChildren();
  for (const [i, chunk] of chunks.entries()) {
    const meta = notebook!.cells[i]!;
    const root = document.createElement('section');
    root.className = `cell kind-${meta.kind}`;
    root.dataset.cell = chunk.id;
    const head = document.createElement('header');
    const title = document.createElement('span');
    title.className = 'cell-name';
    title.textContent = meta.kind === 'setup' ? 'setup' : chunk.id;
    const kind = document.createElement('span');
    kind.className = 'chip';
    kind.textContent = meta.kind === 'action' ? 'action' : meta.kind === 'setup' ? 'imports' : meta.lang;
    const status = document.createElement('span');
    status.className = 'status';
    const reason = document.createElement('span');
    reason.className = 'reason';
    const actions = document.createElement('span');
    actions.className = 'actions';
    const change = document.createElement('span');
    change.className = 'change';
    head.append(title, kind, change, status, reason, actions);
    if (meta.sql) head.append(toggle(chunk.id, meta.sql.kind === 'md'));
    const edHost = document.createElement('div');
    edHost.className = 'cell-editor';
    // A plain SQL cell shows its SQL; its cell() line is kept as written and the rest is written back from the SQL.
    const view = meta.sql && !showTs.has(chunk.id) ? meta.sql : null;
    const head0 = view && meta.body ? chunk.text.slice(0, meta.body.start - chunk.start).trimEnd() : chunk.text.trimEnd();
    if (view) root.classList.add('sql-view');
    const editor = new Editor(edHost, {
      language: view ? (view.kind === 'md' ? markdownLanguage : sqlCellLanguage) : typescriptLanguage,
      value: view ? sqlText(view) : chunk.text.replace(/\n+$/, ''),
      label: view ? `SQL of cell ${chunk.id}` : `Cell ${chunk.id}`,
      onChange: () => edited(),
      keys: {
        'Mod+Enter': () => void runCells([chunk.id]),
        'Shift+Enter': () => { void runCells([chunk.id]); focusNext(chunk.id); },
      },
    });
    const output = document.createElement('div');
    output.className = 'output';
    const controls = document.createElement('div');
    controls.className = 'controls';
    controls.hidden = true;
    const diff = document.createElement('pre');
    diff.className = 'diff';
    diff.hidden = true;
    const history = document.createElement('div');
    history.className = 'history';
    history.hidden = true;
    root.append(head, diff, history, edHost, controls, output);
    cellsEl.append(root);
    // A plain SQL cell is written back from its SQL only once the SQL is edited: untouched, it keeps its text as written
    // in the file, whitespace and all, so opening and saving a notebook changes nothing in it.
    const shown = view ? sqlText(view) : '';
    const asWritten = chunk.text.replace(/\n+$/, '');
    const text = view
      ? () => {
        if (editor.value === shown) return asWritten;
        const body = sqlBody(withSql(view, editor.value));
        return body ? `${head0}\n${body}` : head0;
      }
      : () => editor.value;
    const c: CellUi = { id: chunk.id, root, change, diff, history, editor, status, reason, actions, output, controls, controlsDrawn: '', grid: null, unobserve: null, drawn: '', text };
    ui.set(chunk.id, c);
    sizeEditor(c);
    const state = kernel.state(chunk.id);
    if (state) showState(state);
  }
  if (focusedId) ui.get(focusedId)?.editor.focus();
  showChanges();
}

function sizeEditor(c: CellUi) {
  const lines = Math.max(1, c.editor.value.split('\n').length);
  c.editor.host.style.height = `${lines * 20 + 18}px`;
}

function focusNext(id: string) {
  const ids = [...ui.keys()];
  ui.get(ids[ids.indexOf(id) + 1] ?? id)?.editor.focus();
}

/** The source from the editors: each cell's text, separated by a blank line. */
/** Writes a row type into a plain SQL query cell: `sql<{ … }>`, keeping its SQL as it is in the editor. */
async function pinRowType(id: string, rowType: string) {
  await flush();
  const i = chunks.findIndex((c) => c.id === id);
  const meta = notebook?.cells[i];
  const chunk = chunks[i];
  if (!meta?.sql || meta.sql.kind !== 'query' || !meta.body || !chunk) return;
  const head = chunk.text.slice(0, meta.body.start - chunk.start).trimEnd();
  const text = `${head}\n${sqlBody({ ...meta.sql, rowType })}`;
  source = [...ui.values()].map((c) => (c.id === id ? text : c.text()).replace(/\n+$/, '')).join('\n\n') + '\n';
  save();
  await saveToFolder();
  await kernel.update(source).catch((err: Error) => toast(err.message, 'error'));
}

function currentSource(): string {
  if (sourceView && sourceEditor) return sourceEditor.value.replace(/\n*$/, '\n');
  return [...ui.values()].map((c) => c.text().replace(/\n+$/, '')).join('\n\n') + '\n';
}

/** The TS / SQL switch on a plain SQL cell. */
function toggle(id: string, isText: boolean): HTMLButtonElement {
  const showing = showTs.has(id);
  const back = isText ? 'MD' : 'SQL';
  const b = button(showing ? back : 'TS', showing ? `Show the ${isText ? 'Markdown' : 'SQL'}` : 'Show the TypeScript this cell is saved as', async () => {
    await flush();
    if (showing) showTs.delete(id);
    else showTs.add(id);
    render();
  });
  b.className = 'view-toggle';
  b.setAttribute('aria-pressed', String(showing));
  return b;
}

/** The whole .nb.ts file in one editor. */
function renderSource() {
  for (const c of ui.values()) { c.grid?.destroy(); c.unobserve?.(); }
  ui = new Map();
  const host = document.createElement('div');
  host.className = 'cell-editor source-editor';
  sourceEditor = new Editor(host, { language: typescriptLanguage, value: source.replace(/\n+$/, ''), label: 'Notebook source', onChange: () => edited() });
  host.style.height = `${Math.max(10, source.split('\n').length) * 20 + 18}px`;
  cellsEl.replaceChildren(host);
}

function edited() {
  for (const c of ui.values()) sizeEditor(c);
  showChanges();
  if (sourceEditor) sourceEditor.host.style.height = `${Math.max(10, sourceEditor.value.split('\n').length) * 20 + 18}px`;
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => void send(), 400);
}

async function send() {
  pending = null;
  const next = currentSource();
  if (next === source) return;
  source = next;
  save();
  await saveToFolder();
  await kernel.update(source).catch((err: Error) => toast(err.message, 'error'));
}

async function flush() {
  if (pending) {
    clearTimeout(pending);
    await send();
  }
}

async function runCells(ids: string[], force = false) {
  await flush();
  await kernel.run(ids, { force }).catch((err: Error) => toast(err.message, 'error'));
}

const STATUS_TEXT: Record<CellView['status'], string> = {
  idle: 'not run', running: 'running', ok: 'ok', stale: 'stale', skipped: 'skipped', held: 'held', error: 'error',
};

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function showState(s: CellView) {
  if (graphOpen) updateGraphNode(graphEl, s);
  const c = ui.get(s.id);
  if (!c) return;
  c.root.dataset.status = s.status;
  c.status.textContent = STATUS_TEXT[s.status] + (s.status === 'ok' && s.ms !== null ? ` · ${formatMs(s.ms)}` : '');
  c.reason.textContent = s.reason ?? '';
  c.reason.title = s.reason ?? '';
  const meta = notebook?.cells.find((m) => m.id === s.id);
  const actions: HTMLElement[] = [];
  if (meta && meta.kind !== 'setup') {
    actions.push(button(s.status === 'held' ? 'Run and write' : 'Run', 'Run this cell (Ctrl+Enter)', () => void runCells([s.id])));
    if (s.status === 'skipped' && meta.when) actions.push(button('Run once anyway', 'Ignore the guard this time', () => void runCells([s.id], true)));
  }
  // Row types (DESIGN.md decision 11): pin what the run's columns give, or say when what is pinned no longer matches.
  const rt = s.rowType;
  if (rt && s.status === 'ok' && rt.pinned === null) {
    actions.unshift(button('Pin types', `Write the result's row type into the notebook: sql<${rt.inferred}>`, () => void pinRowType(s.id, rt.inferred)));
  } else if (rt && rt.mismatch) {
    const warn = document.createElement('span');
    warn.className = 'types-warn';
    warn.textContent = 'types out of date';
    warn.title = `The pinned row type no longer matches the result: ${rt.mismatch}`;
    actions.unshift(warn, button('Update types', `Pin sql<${rt.inferred}>`, () => void pinRowType(s.id, rt.inferred)));
  }
  c.actions.replaceChildren(...actions);
  showControls(c, s.controls);
  showOutput(c, s);
}

/** The cell's controls. A change runs the cell again with the new value (null: back to the default). */
function showControls(c: CellUi, controls: ControlInfo[]) {
  const key = JSON.stringify(controls);
  if (key === c.controlsDrawn) return;
  c.controlsDrawn = key;
  c.controls.hidden = controls.length === 0;
  const set = (ctl: ControlInfo, value: unknown) =>
    void flush().then(() => kernel.setControl(c.id, ctl.index, value === ctl.default ? null : value)).catch((err: Error) => toast(err.message, 'error'));
  c.controls.replaceChildren(...controls.map((ctl) => {
    const label = document.createElement('label');
    label.className = `control control-${ctl.kind}`;
    label.dataset.index = String(ctl.index);
    if (ctl.label) {
      const name = document.createElement('span');
      name.className = 'control-label';
      name.textContent = ctl.label;
      label.append(name);
    }
    if (ctl.kind === 'select') {
      // Shared with the other smalt apps: chips for a few options, a list in a menu for many.
      const host = document.createElement('div');
      choiceControl(host, (ctl.options?.length ?? 0) <= 6 ? 'buttons' : 'dropdown', {
        values: ctl.options ?? [], selected: [ctl.value as string], single: true,
        onChange: (v) => set(ctl, v.length ? v[0] : ctl.default),
      });
      label.append(host);
      return label;
    }
    const input = document.createElement('input');
    input.className = 'sk-input';
    input.type = ctl.kind === 'slider' ? 'range' : ctl.kind === 'checkbox' ? 'checkbox' : ctl.kind === 'date' ? 'date' : ctl.kind === 'number' ? 'number' : 'text';
    if (ctl.min !== undefined) input.min = String(ctl.min);
    if (ctl.max !== undefined) input.max = String(ctl.max);
    input.step = ctl.step !== undefined ? String(ctl.step) : 'any';
    if (ctl.kind === 'checkbox') input.checked = ctl.value === true;
    else input.value = String(ctl.value);
    input.title = `Default: ${String(ctl.default)}`;
    label.append(input);
    if (ctl.kind === 'slider') {
      const shown = document.createElement('output');
      shown.textContent = String(ctl.value);
      input.addEventListener('input', () => (shown.textContent = input.value));
      label.append(shown);
    }
    input.addEventListener('change', () => {
      if (ctl.kind === 'checkbox') return set(ctl, input.checked);
      if (ctl.kind === 'slider' || ctl.kind === 'number') {
        if (input.value.trim() === '' || !Number.isFinite(Number(input.value))) return set(ctl, ctl.default);
        return set(ctl, Number(input.value));
      }
      if (ctl.kind === 'date' && input.value === '') return set(ctl, ctl.default);
      set(ctl, input.value);
    });
    return label;
  }));
}

function showOutput(c: CellUi, s: CellView) {
  const key = s.status === 'error' ? `error:${s.error?.message}` : JSON.stringify(s.output.kind === 'table'
    ? { t: s.output.table.table, n: s.output.table.rowCount, runs: s.runs }
    : s.output.kind === 'chart' ? { c: s.output.chart.kind, runs: s.runs } : { o: s.output, runs: s.runs },
    (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
  if (key === c.drawn) return;
  c.drawn = key;
  c.grid?.destroy();
  c.grid = null;
  c.unobserve?.();
  c.unobserve = null;
  c.output.replaceChildren();
  if (s.status === 'error' && s.error) {
    const pre = document.createElement('pre');
    pre.className = 'error';
    pre.textContent = s.error.message;
    c.output.append(pre);
    return;
  }
  const out = s.output;
  if (out.kind === 'table') {
    const { table, preview } = out;
    const box = document.createElement('div');
    box.className = 'table';
    box.style.height = `${Math.min(table.rowCount, 12) * 26 + 32}px`;
    const foot = document.createElement('div');
    foot.className = 'table-foot';
    const count = document.createElement('span');
    count.textContent = `${table.rowCount.toLocaleString()} row${table.rowCount === 1 ? '' : 's'} · ${table.columns.length} column${table.columns.length === 1 ? '' : 's'}`;
    foot.append(count, button('Download CSV', 'Download every row as CSV', () => void downloadCsv(c.id, table.columns, table.rowCount)));
    c.output.append(box, foot);
    c.grid = new Grid(box, { emptyText: 'No rows' });
    c.grid.setSource({
      columns: table.columns.map((name, i) => ({ name, type: table.columnTypes[i] ?? null })),
      rowCount: table.rowCount,
      initial: preview.rows as GridRow[],
      fetch: async (offset, limit) => (await kernel.rows(c.id, offset, limit)).rows as GridRow[],
    });
    return;
  }
  if (out.kind === 'chart') {
    showChart(c, out.chart);
    return;
  }
  if (out.kind === 'markdown') {
    const div = document.createElement('div');
    div.className = 'sk-md markdown';
    div.innerHTML = markdown(out.text); // escaped: raw HTML shows as text
    c.output.append(div);
    return;
  }
  if (out.kind === 'value' || out.kind === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'value';
    pre.textContent = out.kind === 'text' ? out.text : show(out.value);
    c.output.append(pre);
  }
}

const RENDER: Record<ChartOutput['kind'], (ctx: ChartContext) => void> = {
  bar: barChart, column: columnChart, line: lineChart, area: areaChart, pie: pieChart, donut: donutChart, scatter: scatterChart,
};

/** Draws a chart output with smaltkit/charts, again whenever the cell's width changes. */
function showChart(c: CellUi, out: ChartOutput) {
  const o = out.options as ChartOutput['options'] & { series?: string; size?: string; title?: string; height?: number };
  const box = document.createElement('div');
  box.className = 'chart';
  const height = o.height ?? 280;
  box.style.height = `${height}px`;
  if (o.title) {
    const h = document.createElement('div');
    h.className = 'chart-title';
    h.textContent = o.title;
    c.output.append(h);
  }
  c.output.append(box);
  if (out.rowCount > out.rows.length) {
    const note = document.createElement('div');
    note.className = 'table-foot';
    note.textContent = `Drawn from the first ${out.rows.length.toLocaleString()} of ${out.rowCount.toLocaleString()} rows.`;
    c.output.append(note);
  }
  const ys = typeof o.y === 'string' ? [o.y] : [...o.y];
  const scatter = out.kind === 'scatter';
  type Role = [key: string, role: string, kind: 'dimension' | 'measure'];
  const roles: Role[] = scatter ? [[o.x, 'x', 'measure'], [ys[0]!, 'y', 'measure']] : [[o.x, 'category', 'dimension'], ...ys.map((y): Role => [y, 'values', 'measure'])];
  if (scatter && o.size) roles.push([o.size, 'size', 'measure']);
  if (o.series) roles.push([o.series, scatter ? 'legend' : 'series', 'dimension']);
  const columns: ChartColumn[] = roles.map(([key, role, kind]) => {
    const i = out.columns.indexOf(key);
    return { key, role, label: key, kind, values: out.rows.map((r) => r[i] as never), fmt: formatValue };
  });
  const draw = () => {
    const width = box.clientWidth;
    if (!width) return;
    RENDER[out.kind]({
      el: box, width, height, options: { ...o, legend: 'auto' },
      data: chartData(columns, out.rows.length), extra: {}, palette: 12, selected: () => null,
    });
  };
  draw();
  let last = box.clientWidth;
  const ro = new ResizeObserver(() => { if (box.clientWidth !== last) { last = box.clientWidth; draw(); } });
  ro.observe(box);
  c.unobserve = () => ro.disconnect();
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === 'bigint') return v.toLocaleString();
  return String(v);
}

async function downloadCsv(id: string, columns: string[], rowCount: number) {
  const rows = (await kernel.rows(id, 0, rowCount)).rows as GridRow[];
  download(`${fileName(id)}.csv`, exportRows('csv', columns, rows), 'text/csv');
}

function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v), 2);
  } catch {
    return String(value);
  }
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// A local repository folder (ADR 0032): notebooks open from a folder on disk and save back to it as plain files; in a
// git repository, each cell is marked against the last commit. Commits and syncing are the user's, in their own tools.
const folderButton = $<HTMLButtonElement>('#folder');
const fileSelect = $<HTMLSelectElement>('#folder-file');
const gitEl = $('#git-status');
const removedEl = $('#removed');
let folder: RepoFolder | null = null;
let folderPath: string | null = null;
/** Each cell's text at the last commit (null: no committed version), for the open folder notebook. */
let headCells: Map<string, string> | null = null;
let headKnown = false;
const openDiffs = new Set<string>();

folderButton.hidden = !canOpenFolders;

async function useFolder(root: FileSystemDirectoryHandle, path: string | null) {
  folder = await RepoFolder.open(root);
  fileSelect.replaceChildren(new Option(folder.notebooks.length ? 'Open a notebook…' : 'No .nb.ts files here', ''), ...folder.notebooks.map((p) => new Option(p, p)));
  fileSelect.hidden = false;
  folderButton.textContent = `${folder.name}/`;
  folderButton.title = 'Open another folder';
  if (path && folder.notebooks.includes(path)) await openFromFolder(path);
  else await rememberFolder(root, null);
  await showGitStatus();
}

async function openFromFolder(path: string) {
  if (!folder) return;
  await flush();
  clearUrlParams();
  const text = await folder.read(path);
  folderPath = path;
  fileSelect.value = path;
  await rememberFolder(folder.root, path);
  const name = path.split('/').pop()!.replace(/\.nb\.ts$/, '');
  if (hasConflictMarkers(text)) return showResolver(text, name);
  await load(text, name);
  await readHead();
}

// Merge conflicts by cell (ADR 0032): a notebook with git's conflict markers opens in a resolver, cell by cell. Saving
// writes the notebook without markers (to the folder's file); the user marks it resolved and commits in their own tools.
async function showResolver(text: string, name: string) {
  let sides;
  try {
    sides = conflictSides(text);
  } catch (err) {
    toast(`${(err as Error).message} Opened as it is.`, 'error');
    return load(text, name);
  }
  const fileName = `${name}.nb.ts`;
  const cellsOf = async (src: string): Promise<SideCell[]> => split(src, await kernel.parse(src, fileName)).map((c) => ({ id: c.id, text: c.text.replace(/\n+$/, '') }));
  const merged = mergeCells(await cellsOf(sides.ours), await cellsOf(sides.theirs), sides.base === null ? null : await cellsOf(sides.base));
  const choices: Record<string, CellChoice | undefined> = {};
  nameEl.value = name;
  fitName();
  for (const c of ui.values()) { c.grid?.destroy(); c.unobserve?.(); }
  ui = new Map();
  removedEl.hidden = true;
  const box = document.createElement('section');
  box.className = 'resolver';
  const oursName = sides.oursLabel || 'ours';
  const theirsName = sides.theirsLabel || 'theirs';
  const differs = merged.filter((c) => c.kind === 'differs');
  const intro = document.createElement('p');
  intro.textContent = `This notebook has ${sides.count} merge conflict${sides.count === 1 ? '' : 's'} between ${oursName} (ours) and ${theirsName} (theirs). `
    + `${differs.length} cell${differs.length === 1 ? ' differs' : 's differ'}: choose a version of each, then save. `
    + `${merged.filter((c) => c.kind === 'same').length} cells are the same on both sides.`;
  const save = button('Save resolved notebook', 'Write the notebook without conflict markers', () => void finish());
  save.className = 'primary';
  const left = document.createElement('span');
  left.className = 'resolver-left';
  const refresh = () => {
    const open = merged.filter((c) => (choices[c.id] ?? defaultChoice(c)) === null).length;
    save.disabled = open > 0;
    left.textContent = open ? `${open} to choose` : 'Ready to save';
  };
  const cards = merged.filter((c) => c.kind !== 'same').map((c) => card(c, choices, refresh, oursName, theirsName));
  const foot = document.createElement('div');
  foot.className = 'resolver-foot';
  foot.append(save, left);
  box.append(intro, ...cards, foot);
  cellsEl.replaceChildren(box);
  refresh();

  async function finish() {
    const resolved = resolveCells(merged, choices);
    source = resolved;
    if (folder && folderPath) await folder.write(folderPath, resolved).catch((err: Error) => toast(`Couldn't save ${folderPath}: ${err.message}`, 'error'));
    await load(resolved, name);
    await readHead();
    toast('Saved without conflict markers. Mark it resolved (git add) and commit, in your own tools.');
  }
}

/** One cell of the resolver: both versions side by side (or one side's cell), with the choices for it. */
function card(c: MergeCell, choices: Record<string, CellChoice | undefined>, refresh: () => void, oursName: string, theirsName: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'resolve-cell';
  el.dataset.cell = c.id;
  const head = document.createElement('div');
  head.className = 'resolve-head';
  const title = document.createElement('span');
  title.className = 'cell-name';
  title.textContent = c.id;
  const what = document.createElement('span');
  what.className = 'resolve-what';
  head.append(title, what);
  el.append(head);
  const pick = (choice: CellChoice, chosen: HTMLElement) => {
    choices[c.id] = choice;
    for (const b of el.querySelectorAll('.resolve-choices button')) b.setAttribute('aria-pressed', String(b === chosen));
    refresh();
  };
  const choicesRow = document.createElement('div');
  choicesRow.className = 'resolve-choices';
  if (c.kind === 'differs') {
    what.textContent = c.base === null ? 'changed on both sides' : 'changed on both sides since their common version';
    const sides = document.createElement('div');
    sides.className = 'resolve-sides';
    for (const [label, text] of [[`ours (${oursName})`, c.ours], [`theirs (${theirsName})`, c.theirs]] as const) {
      const col = document.createElement('div');
      const h = document.createElement('div');
      h.className = 'resolve-label';
      h.textContent = label;
      const pre = document.createElement('pre');
      pre.textContent = text;
      col.append(h, pre);
      sides.append(col);
    }
    const edit = document.createElement('textarea');
    edit.className = 'resolve-edit';
    edit.hidden = true;
    edit.spellcheck = false;
    edit.value = c.ours;
    edit.rows = Math.min(16, c.ours.split('\n').length + 1);
    const ours = button('Keep ours', `Use ${oursName}'s version`, () => { edit.hidden = true; pick('ours', ours); });
    const theirs = button('Keep theirs', `Use ${theirsName}'s version`, () => { edit.hidden = true; pick('theirs', theirs); });
    const write = button('Write it…', 'Write the cell yourself, starting from ours', () => { edit.hidden = false; pick({ text: edit.value }, write); edit.focus(); });
    edit.addEventListener('input', () => (choices[c.id] = { text: edit.value }));
    choicesRow.append(ours, theirs, write);
    el.append(sides, choicesRow, edit);
  } else if (c.kind !== 'same') {
    const side = c.kind === 'ours-only' ? `ours (${oursName})` : `theirs (${theirsName})`;
    const other = c.kind === 'ours-only' ? 'theirs' : 'ours';
    what.textContent = c.base === null ? `only in ${side}` : `only in ${side}: ${other} removed it`;
    const pre = document.createElement('pre');
    pre.textContent = c.text;
    const keep = button('Keep', 'Keep this cell', () => pick('keep', keep));
    const drop = button('Drop', 'Leave this cell out', () => pick('drop', drop));
    keep.setAttribute('aria-pressed', 'true');
    choicesRow.append(keep, drop);
    el.append(pre, choicesRow);
  }
  return el;
}

/** Leaves the folder's notebook (another notebook was opened): the folder stays open. */
function leaveFolderFile() {
  folderPath = null;
  headCells = null;
  headKnown = false;
  fileSelect.value = '';
  void rememberFolder(folder?.root ?? null, null);
  showChanges();
  void showGitStatus();
}

async function saveToFolder() {
  if (!folder || !folderPath) return;
  try {
    await folder.write(folderPath, source);
  } catch (err) {
    toast(`Couldn't save ${folderPath}: ${(err as Error).message}`, 'error');
  }
  await showGitStatus();
}

/** Reads the notebook as it is at the last commit, into its cells. */
async function readHead() {
  headCells = null;
  headKnown = false;
  if (folder?.repo && folderPath) {
    headId = await folder.repo.resolve('HEAD').catch(() => '');
    const text = await folder.atHead(folderPath);
    if (text !== null) {
      const nb = await kernel.parse(text, folderPath);
      headCells = new Map(split(text, nb).map((c) => [c.id, c.text.trim()]));
    }
    headKnown = true;
  }
  showChanges();
  await showGitStatus();
}

let gitStatusRun = 0;

async function showGitStatus() {
  // Reading git is asynchronous: only the latest call writes, so an older one finishing late can't overwrite it.
  const run = ++gitStatusRun;
  const f = folder;
  const path = folderPath;
  const text = source;
  const branch = await f?.branch() ?? null;
  const changed = f && branch && path ? await f.changedSinceHead(path, text) : null;
  if (run !== gitStatusRun) return;
  gitEl.hidden = !f;
  if (!f) return;
  const parts = [branch ? `on ${branch}` : 'not a git repository'];
  if (changed !== null) parts.push(changed ? 'changed since the last commit' : 'no changes since the last commit');
  gitEl.textContent = parts.join(' · ');
  gitEl.title = 'Commit and sync with your own git tools: this page only reads the repository.';
}

/** Marks each cell new or changed against the last commit, and lists cells removed since. */
const openHistory = new Set<string>();
/** A cell's changes in git, by notebook path, HEAD and cell, read once. */
const historyCache = new Map<string, Promise<CellChange<GitCommit>[]>>();
const HISTORY_LIMIT = 50;

function historyKey(c: CellUi): string {
  return `${folderPath}\n${headId}\n${c.id}\n${c.text().trim()}\n${blameOn.has(c.id)}`;
}

let headId = '';

/** The commits that changed a cell, newest first: the notebook at each commit that changed its file, read into cells. */
function cellHistory(id: string): Promise<CellChange<GitCommit>[]> {
  const key = `${folderPath}\n${headId}\n${id}`;
  let found = historyCache.get(key);
  if (!found) {
    const f = folder!;
    const path = folderPath!;
    found = (async () => {
      const commits = await f.repo!.log('HEAD', { path, limit: HISTORY_LIMIT });
      const versions = [];
      for (const commit of commits) {
        const text = await f.repo!.readText(commit.id, path);
        const cells = text === null ? [] : split(text, await kernel.parse(text, path));
        versions.push({ commit, text: cells.find((x) => x.id === id)?.text.trim() ?? null });
      }
      return cellChanges(versions);
    })();
    historyCache.set(key, found);
  }
  return found;
}

const blameOn = new Set<string>();

async function showHistoryOf(c: CellUi) {
  const key = historyKey(c);
  c.history.dataset.drawn = key;
  c.history.replaceChildren(Object.assign(document.createElement('div'), { className: 'history-note', textContent: 'Reading history…' }));
  let changes: CellChange<GitCommit>[];
  try {
    changes = await cellHistory(c.id);
  } catch (err) {
    c.history.replaceChildren(Object.assign(document.createElement('div'), { className: 'history-note', textContent: `Couldn't read the history: ${(err as Error).message}` }));
    return;
  }
  if (c.history.dataset.drawn !== key) return; // redrawn meanwhile
  const top = document.createElement('div');
  top.className = 'history-head';
  const note = document.createElement('span');
  note.textContent = changes.length
    ? `${changes.length} commit${changes.length === 1 ? '' : 's'} changed this cell${changes.length === HISTORY_LIMIT ? ` (the last ${HISTORY_LIMIT} of the file's)` : ''}`
    : 'No commit has this cell yet';
  const blame = button(blameOn.has(c.id) ? 'Hide blame' : 'Blame', 'For each line, the commit that last changed it', () => {
    if (blameOn.has(c.id)) blameOn.delete(c.id);
    else blameOn.add(c.id);
    void showHistoryOf(c);
  });
  blame.className = 'diff-toggle blame-toggle';
  top.append(note, ...(changes.length ? [blame] : []));
  const parts: HTMLElement[] = [top];
  if (blameOn.has(c.id)) {
    const pre = document.createElement('pre');
    pre.className = 'blame';
    for (const l of blameLines(c.text().trim(), changes, diffLines)) {
      const who = document.createElement('span');
      who.className = 'blame-who';
      who.textContent = l.commit ? `${l.commit.id.slice(0, 7)} ${l.commit.author.name}`.padEnd(22).slice(0, 22) : 'not committed'.padEnd(22);
      if (l.commit) who.title = `${new Date(l.commit.author.time * 1000).toISOString().slice(0, 10)} · ${l.commit.message.split('\n')[0]}`;
      pre.append(who, ` ${l.text}\n`);
    }
    parts.push(pre);
  }
  const list = document.createElement('ol');
  list.className = 'history-list';
  for (const ch of changes) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-row';
    const when = new Date(ch.commit.author.time * 1000).toISOString().slice(0, 10);
    row.textContent = `${ch.commit.id.slice(0, 7)} · ${when} · ${ch.commit.author.name} · ${ch.commit.message.split('\n')[0]}${ch.before === null ? ' (added the cell)' : ''}`;
    const detail = document.createElement('div');
    detail.className = 'history-detail';
    detail.hidden = true;
    row.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      if (detail.hidden || detail.childElementCount) return;
      const pre = document.createElement('pre');
      pre.className = 'diff';
      pre.append(...diffLines(ch.before ?? '', ch.text).map((l) => {
        const line = document.createElement('span');
        line.className = l.op;
        line.textContent = `${l.op === 'add' ? '+' : l.op === 'remove' ? '-' : ' '} ${l.text}\n`;
        return line;
      }));
      const use = button('Use this version', "Put this commit's version of the cell in the notebook (the file in your folder; commit it with your own tools)", () => void useVersion(c.id, ch.text));
      detail.append(pre, use);
    });
    li.append(row, detail);
    list.append(li);
  }
  parts.push(list);
  c.history.replaceChildren(...parts);
}

/** Puts an earlier version of a cell in the notebook, as an edit: saved to the folder's file, and the cell reruns. */
async function useVersion(id: string, text: string) {
  await flush();
  source = [...ui.values()].map((c) => (c.id === id ? text : c.text()).replace(/\n+$/, '')).join('\n\n') + '\n';
  save();
  await saveToFolder();
  forceRender = true;
  await kernel.update(source).catch((err: Error) => toast(err.message, 'error'));
}

function showChanges() {
  const marking = headKnown && !sourceView;
  for (const c of ui.values()) {
    const before = headCells?.get(c.id);
    const now = c.text().trim();
    const state = !marking ? '' : before === undefined ? 'new' : before !== now ? 'changed' : '';
    c.root.dataset.change = state;
    c.change.replaceChildren();
    if (state) {
      const chip = document.createElement('span');
      chip.className = `change-chip ${state}`;
      chip.textContent = state;
      chip.title = state === 'new' ? 'Not in the last commit' : 'Changed since the last commit';
      c.change.append(chip);
      if (state === 'changed') {
        const b = button(openDiffs.has(c.id) ? 'Hide diff' : 'Diff', 'Show what changed in this cell since the last commit', () => {
          if (openDiffs.has(c.id)) openDiffs.delete(c.id);
          else openDiffs.add(c.id);
          showChanges();
        });
        b.className = 'diff-toggle';
        c.change.append(b);
      }
    }
    if (marking && folder?.repo && c.id !== 'setup') {
      const h = button(openHistory.has(c.id) ? 'Hide history' : 'History', 'The commits that changed this cell, and blame', () => {
        if (openHistory.has(c.id)) openHistory.delete(c.id);
        else openHistory.add(c.id);
        showChanges();
      });
      h.className = 'diff-toggle history-toggle';
      c.change.append(h);
    }
    const showHistory = marking && openHistory.has(c.id);
    c.history.hidden = !showHistory;
    if (showHistory && c.history.dataset.drawn !== historyKey(c)) void showHistoryOf(c);
    const show = state === 'changed' && openDiffs.has(c.id);
    c.diff.hidden = !show;
    if (show) {
      c.diff.replaceChildren(...diffLines(before!, now).map((l) => {
        const line = document.createElement('span');
        line.className = l.op;
        line.textContent = `${l.op === 'add' ? '+' : l.op === 'remove' ? '-' : ' '} ${l.text}\n`;
        return line;
      }));
    }
  }
  const removed = marking && headCells ? [...headCells.keys()].filter((id) => !ui.has(id)) : [];
  removedEl.hidden = removed.length === 0;
  removedEl.textContent = removed.length ? `Removed since the last commit: ${removed.join(', ')}` : '';
}

folderButton.addEventListener('click', async () => {
  const remembered = folderButton.dataset.reopen === '1' ? await rememberedFolder() : null;
  if (remembered && (await requestAccess(remembered.root))) {
    delete folderButton.dataset.reopen;
    return useFolder(remembered.root, remembered.path);
  }
  const root = await pickFolder();
  if (root) await useFolder(root, null);
});
fileSelect.addEventListener('change', () => {
  if (fileSelect.value) void openFromFolder(fileSelect.value);
});
// The user may commit (or switch branches) in their own tools while the page is open.
addEventListener('focus', () => {
  if (folder && folderPath) void RepoFolder.open(folder.root).then((f) => { folder = f; return readHead(); });
});

function save() {
  try {
    localStorage.setItem(STORE, source);
    localStorage.setItem(NAME, nameEl.value);
  } catch {
    // Storage blocked: the notebook still works, it just isn't kept.
  }
}

async function load(src: string, name: string, params: Record<string, string> = {}) {
  source = src.endsWith('\n') ? src : src + '\n';
  nameEl.value = name;
  fitName();
  chunks = [];
  sourceView = false;
  sourceButton.setAttribute('aria-pressed', 'false');
  sourceButton.textContent = 'Source';
  showTs.clear();
  save();
  await kernel.open(source, `${name}.nb.ts`, params);
  await kernel.runAll().catch((err: Error) => toast(err.message, 'error'));
}

function addCell(kind: 'cell' | 'action' | 'sql' | 'md') {
  const prefix = kind === 'sql' ? 'query' : kind === 'md' ? 'text' : kind;
  const ids = new Set(chunks.map((c) => c.id));
  let n = chunks.length;
  while (ids.has(`${prefix}${n}`)) n++;
  const id = `${prefix}${n}`;
  const added = kind === 'md'
    ? `cell('${id}', { lang: 'md' });\n${sqlBody({ kind: 'md', text: 'Write here: **Markdown**.' })}`
    : kind === 'sql'
    ? `cell('${id}', { lang: 'sql' });\n${sqlBody({ kind: 'query', name: id, exported: true, rowType: null, text: 'SELECT 1 AS one', output: true })}`
    : `${kind}('${id}');`;
  source = currentSource() + `\n${added}\n`;
  save();
  void saveToFolder();
  void kernel.update(source);
}

$('#run-all').addEventListener('click', async () => {
  await flush();
  await kernel.runAll().catch((err: Error) => toast(err.message, 'error'));
});
$('#restart').addEventListener('click', async () => {
  await kernel.restart();
  toast('The kernel was restarted. Run the cells again to get their results back.');
});
$('#add-cell').addEventListener('click', () => addCell('cell'));
$('#add-action').addEventListener('click', () => addCell('action'));
$('#add-sql').addEventListener('click', () => addCell('sql'));
$('#add-md').addEventListener('click', () => addCell('md'));
const sourceButton = $<HTMLButtonElement>('#source');
sourceButton.addEventListener('click', async () => {
  await flush();
  sourceView = !sourceView;
  sourceButton.setAttribute('aria-pressed', String(sourceView));
  sourceButton.textContent = sourceView ? 'Cells' : 'Source';
  if (!sourceView && notebook) chunks = split(source, notebook);
  render();
});
$('#open').addEventListener('click', async () => {
  const file = await pickFile('.ts,.nb.ts,text/plain');
  if (!file) return;
  clearUrlParams();
  leaveFolderFile();
  const text = await file.text();
  const name = file.name.replace(/(\.nb)?\.ts$/, '');
  if (hasConflictMarkers(text)) await showResolver(text, name);
  else await load(text, name);
});
$('#save').addEventListener('click', async () => {
  await flush();
  download(`${fileName(nameEl.value || 'notebook')}.nb.ts`, source, 'text/typescript');
});
$('#demo').addEventListener('click', async () => {
  clearUrlParams();
  leaveFolderFile();
  await load(await (await fetch('demo.nb.ts')).text(), 'shop');
});

/** Parameter values belong to the notebook they were set on: another notebook starts from its defaults. */
function clearUrlParams() {
  history.replaceState(null, '', location.pathname);
}
const fitName = () => (nameEl.size = Math.min(30, Math.max(4, nameEl.value.length)));
nameEl.addEventListener('input', fitName);
nameEl.addEventListener('change', save);

async function start() {
  let src: string | null = null;
  let name = 'shop';
  try {
    src = localStorage.getItem(STORE);
    name = localStorage.getItem(NAME) || name;
  } catch {
    // Storage blocked.
  }
  if (!src) src = await (await fetch('demo.nb.ts')).text();
  // ?minQty=5 in the page's address sets that parameter, so a link can share values.
  await load(src, name, Object.fromEntries(new URLSearchParams(location.search)));
  // The folder open last time: reopened when access is still granted, else one click asks again.
  const remembered = canOpenFolders ? await rememberedFolder() : null;
  if (remembered?.granted) await useFolder(remembered.root, remembered.path).catch(() => {});
  else if (remembered) {
    folderButton.dataset.reopen = '1';
    folderButton.textContent = `Reopen ${remembered.root.name}/`;
    folderButton.title = 'The browser asks again before the page can use this folder';
  }
}

void start();
