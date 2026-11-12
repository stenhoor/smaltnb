// Charts in a notebook. `chart.bar(byRegion, { x: 'region', y: 'revenue' })` as a cell's last expression shows a chart
// of that result as the cell's output. The data is a query, a smaltdf frame, another cell's collected result, or an
// array of row objects. The runtime collects a query or frame like any other result, reads up to `CHART_ROWS` rows of
// it, and the page draws them with smaltkit/charts (DESIGN.md decisions 13 and 22): a chart of more rows says so.

import type { Row, SqlQuery } from './sql.js';

export type ChartKind = 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'scatter';

/** The most rows a chart reads. A result with more is drawn from its first rows, with a warning. */
export const CHART_ROWS = 5000;

/** Bars, columns, lines and areas: a category along one axis, one or more measures along the other. */
export interface SeriesChartOptions<K extends string = string> {
  /** The column of categories. */
  x: K;
  /** The column of values, or several columns, one series each. */
  y: K | readonly K[];
  /** A column whose values split the (single) measure into series. */
  series?: K;
  /** How series combine: side by side (`none`, the default), on top of each other, or as shares of 100%. */
  stack?: 'none' | 'stacked' | 'percent';
  /** Values written on the marks. */
  labels?: boolean;
  /** Lines and areas: curves instead of straight segments. */
  smooth?: boolean;
  /** Lines and areas: a dot on each value. */
  markers?: boolean;
  /** A title above the chart. */
  title?: string;
  /** Height in pixels. Default 280. */
  height?: number;
}

/** Pie and donut: a category and one measure. */
export interface PieChartOptions<K extends string = string> {
  x: K;
  y: K;
  labels?: boolean;
  title?: string;
  height?: number;
}

/** Scatter: one point per row. */
export interface ScatterChartOptions<K extends string = string> {
  x: K;
  y: K;
  /** A column that sizes the points (a bubble chart). */
  size?: K;
  /** A column that colours the points by group. */
  series?: K;
  title?: string;
  height?: number;
}

export type ChartOptions = SeriesChartOptions | PieChartOptions | ScatterChartOptions;

/** A chart, not yet drawn: the runtime reads its data when the cell finishes. */
export class Chart {
  readonly kind: ChartKind;
  readonly data: unknown;
  readonly options: Readonly<ChartOptions>;
  constructor(kind: ChartKind, data: unknown, options: ChartOptions) {
    this.kind = kind;
    this.data = data;
    this.options = Object.freeze({ ...options });
  }

  /** The columns the chart reads, in the order x, y…, series, size. */
  columns(): string[] {
    const o = this.options as SeriesChartOptions & ScatterChartOptions;
    const ys = typeof o.y === 'string' ? [o.y] : [...(o.y ?? [])];
    return [o.x, ...ys, o.series, o.size].filter((c): c is string => typeof c === 'string');
  }
}

/** A chart's data as the page draws it: the columns it reads and up to CHART_ROWS rows. */
export interface ChartOutput {
  kind: ChartKind;
  options: ChartOptions;
  columns: string[];
  rows: unknown[][];
  /** How many rows the data has: more than `rows.length` when the chart was cut to CHART_ROWS. */
  rowCount: number;
}

/** The column names a chart can name: a query's or rows' keys, or any text for other data. */
type Keys<D> = D extends SqlQuery<infer R> ? keyof R & string
  : D extends readonly (infer R)[] ? (R extends Row ? keyof R & string : string)
  : string;

function make(kind: ChartKind) {
  return (data: unknown, options: ChartOptions): Chart => {
    if (!options || typeof options.x !== 'string' || typeof options.y === 'undefined') {
      throw new Error(`chart.${kind}: give the columns to draw, as { x: 'column', y: 'column' }.`);
    }
    return new Chart(kind, data, options);
  };
}

type SeriesFn = <D>(data: D, options: SeriesChartOptions<Keys<D>>) => Chart;
type PieFn = <D>(data: D, options: PieChartOptions<Keys<D>>) => Chart;
type ScatterFn = <D>(data: D, options: ScatterChartOptions<Keys<D>>) => Chart;

export interface ChartFunctions {
  /** Horizontal bars. */
  bar: SeriesFn;
  /** Vertical columns. */
  column: SeriesFn;
  line: SeriesFn;
  area: SeriesFn;
  pie: PieFn;
  donut: PieFn;
  /** Points: `x` and `y` are both numbers. */
  scatter: ScatterFn;
}

/** Charts of a result, shown as a cell's output. */
export const chart: ChartFunctions = {
  bar: make('bar') as SeriesFn,
  column: make('column') as SeriesFn,
  line: make('line') as SeriesFn,
  area: make('area') as SeriesFn,
  pie: make('pie') as PieFn,
  donut: make('donut') as PieFn,
  scatter: make('scatter') as ScatterFn,
};

/**
 * @internal A chart's rows from an array of row objects: the columns it reads, checked, and at most CHART_ROWS rows.
 */
export function chartFromRows(c: Chart, rows: readonly Row[]): ChartOutput {
  const columns = c.columns();
  const known = new Set(rows.flatMap((r) => Object.keys(r)));
  if (rows.length) checkColumns(c, columns, [...known]);
  const cut = rows.slice(0, CHART_ROWS);
  return { kind: c.kind, options: { ...c.options }, columns, rows: cut.map((r) => columns.map((k) => r[k])), rowCount: rows.length };
}

/** @internal Fails with the result's columns when the chart names one it doesn't have. */
export function checkColumns(c: Chart, wanted: string[], have: string[]): void {
  const missing = wanted.filter((w) => !have.includes(w));
  if (missing.length) {
    throw new Error(`chart.${c.kind}: no column ${missing.map((m) => `"${m}"`).join(', ')} in the data (it has ${have.map((h) => `"${h}"`).join(', ') || 'no columns'}).`);
  }
}
