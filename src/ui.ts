// Controls in a cell: inputs drawn under the cell, whose values its code reads.
//
//   cell('byRegion', { lang: 'sql' });
//   const region = ui.select(['all', 'north', 'south'], 'all');
//   export const byRegion = sql`SELECT … WHERE ${region.value} IN ('all', region)`;
//
// A control's value is kept by the runtime, per cell, in the order the cell declares its controls. Changing it in the
// page runs the cell again, and what reads the cell reacts as to an edit. Outside a running notebook (a library import,
// a plain run) each control has its default value. Unlike param(), a control is the page's: it isn't in the page's
// address and a headless run uses the default.

export type ControlKind = 'select' | 'slider' | 'number' | 'text' | 'checkbox' | 'date';

/** A control as a cell declares it: its kind, its default, and how a value from the page is checked. */
export interface ControlSpec<T> {
  readonly kind: ControlKind;
  readonly default: T;
  readonly label?: string;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** The value for one from the page; throws when it doesn't fit. */
  check(value: unknown): T;
}

/** What a cell gets back: the control's value in use. */
export interface Control<T> {
  readonly value: T;
}

/** A control as the page draws it. */
export interface ControlInfo {
  /** Its place among the cell's controls, from 0: how the page names it in setControl. */
  index: number;
  kind: ControlKind;
  label: string | null;
  value: unknown;
  default: unknown;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

/** How a control finds its value: the runtime's resolver, or the default. */
export type ControlResolver = <T>(spec: ControlSpec<T>) => T;

export interface LabelOption {
  /** Shown beside the control. */
  label?: string;
}

export interface RangeOptions extends LabelOption {
  min?: number;
  max?: number;
  step?: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(t: string): boolean {
  return ISO_DATE.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`)) && new Date(`${t}T00:00:00Z`).toISOString().slice(0, 10) === t;
}

function finite(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${JSON.stringify(v)} is not a number.`);
  return v;
}

function select<const T extends string>(options: readonly T[], value: T, o: LabelOption = {}): ControlSpec<T> {
  if (!options.includes(value)) throw new Error(`ui.select: the default "${value}" is not one of the options.`);
  return {
    kind: 'select', default: value, options, ...o,
    check: (v) => {
      if (!(options as readonly unknown[]).includes(v)) throw new Error(`${JSON.stringify(v)} is not one of the options.`);
      return v as T;
    },
  };
}

function inRange(kind: 'slider' | 'number', value: number, o: RangeOptions): ControlSpec<number> {
  return {
    kind, default: value, ...o,
    check: (v) => {
      const n = finite(v);
      if ((o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) throw new Error(`${n} is out of range.`);
      return n;
    },
  };
}

function slider(min: number, max: number, value: number, o: Omit<RangeOptions, 'min' | 'max'> = {}): ControlSpec<number> {
  if (!(min <= value && value <= max)) throw new Error(`ui.slider: the default ${value} is not between ${min} and ${max}.`);
  return inRange('slider', value, { ...o, min, max });
}

function number(value: number, o: RangeOptions = {}): ControlSpec<number> {
  return inRange('number', value, o);
}

function text(value: string, o: LabelOption = {}): ControlSpec<string> {
  return {
    kind: 'text', default: value, ...o,
    check: (v) => {
      if (typeof v !== 'string') throw new Error(`${JSON.stringify(v)} is not text.`);
      return v;
    },
  };
}

function checkbox(value: boolean, o: LabelOption = {}): ControlSpec<boolean> {
  return {
    kind: 'checkbox', default: value, ...o,
    check: (v) => {
      if (typeof v !== 'boolean') throw new Error(`${JSON.stringify(v)} is not true or false.`);
      return v;
    },
  };
}

function date(value: string, o: LabelOption = {}): ControlSpec<string> {
  if (!isDate(value)) throw new Error(`ui.date: the default "${value}" is not a date written YYYY-MM-DD.`);
  return {
    kind: 'date', default: value, ...o,
    check: (v) => {
      if (typeof v !== 'string' || !isDate(v)) throw new Error(`${JSON.stringify(v)} is not a date written YYYY-MM-DD.`);
      return v;
    },
  };
}

type Specs = {
  select: typeof select;
  slider: typeof slider;
  number: typeof number;
  text: typeof text;
  checkbox: typeof checkbox;
  date: typeof date;
};

type Wrap<F> = F extends (...args: infer A) => ControlSpec<infer T> ? (...args: A) => Control<T> : never;

export type UiFunctions = {
  /** One of these strings, as buttons (or a list, for many). The value's type is their union. */
  select: Wrap<typeof select>;
  /** A number between min and max, as a slider. */
  slider: Wrap<typeof slider>;
  /** A number, typed in; `min`, `max` and `step` are optional. */
  number: Wrap<typeof number>;
  /** Text, typed in. */
  text: Wrap<typeof text>;
  checkbox: Wrap<typeof checkbox>;
  /** A date as `YYYY-MM-DD` text: what SQL compares and a date input gives. */
  date: Wrap<typeof date>;
};

/** A `ui` whose controls find their values with `resolve`. */
export function createUi(resolve: ControlResolver): UiFunctions {
  const specs: Specs = { select, slider, number, text, checkbox, date };
  const out: Record<string, unknown> = {};
  for (const [name, make] of Object.entries(specs)) {
    out[name] = (...args: unknown[]) => Object.freeze({ value: resolve((make as (...a: unknown[]) => ControlSpec<unknown>)(...args)) });
  }
  return out as UiFunctions;
}

/** Controls in a cell. Outside a running notebook, each has its default value. */
export const ui: UiFunctions = createUi((spec) => spec.default);

/** @internal A control as the page draws it. */
export function controlInfo<T>(index: number, spec: ControlSpec<T>, value: T): ControlInfo {
  return {
    index, kind: spec.kind, label: spec.label ?? null, value, default: spec.default,
    ...(spec.options && { options: [...spec.options] }),
    ...(spec.min !== undefined && { min: spec.min }),
    ...(spec.max !== undefined && { max: spec.max }),
    ...(spec.step !== undefined && { step: spec.step }),
  };
}
