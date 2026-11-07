// Notebook parameters: typed values set from outside the notebook (the page's params bar, its URL, later a headless
// run), with defaults in the source.
//
//   export const params = param({
//     mode: param.choice(['incremental', 'full'], 'incremental'),
//     since: param.isoDate('2026-10-01'),
//   });
//   // params.mode: 'incremental' | 'full'
//
// Outside a running notebook (a library import, a plain run) param() gives the defaults. In the runtime, values come
// in as text, as a URL gives them, and each is checked: one that doesn't fit is an error on the cell that declares it.

export type ParamKind = 'choice' | 'text' | 'number' | 'bool' | 'isoDate';

/** One parameter: its kind, its default, and how text from outside becomes its value. */
export interface ParamSpec<T> {
  readonly kind: ParamKind;
  readonly default: T;
  /** The values a `choice` allows. */
  readonly choices?: readonly string[];
  /** The value for text from outside; throws with a message when the text doesn't fit. */
  parse(text: string): T;
}

/** A parameter as the page shows it. */
export interface ParamInfo {
  name: string;
  kind: ParamKind;
  /** The default, as text. */
  default: string;
  /** The value in use, as text. */
  value: string;
  choices?: string[];
  /** The cell that declares it. */
  cell: string;
  /** Why the value given from outside doesn't fit; the cell fails with this until it's changed. */
  error?: string;
}

type Values<S> = { readonly [K in keyof S]: S[K] extends ParamSpec<infer T> ? T : never };

/** How param() finds a value: the runtime's resolver, or the default. */
export type ParamResolver = <T>(name: string, spec: ParamSpec<T>) => T;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function choice<const T extends string>(choices: readonly T[], value: T): ParamSpec<T> {
  return {
    kind: 'choice', default: value, choices,
    parse: (text) => {
      if (!(choices as readonly string[]).includes(text)) throw new Error(`"${text}" is not one of ${choices.map((c) => `"${c}"`).join(', ')}.`);
      return text as T;
    },
  };
}

function text(value: string): ParamSpec<string> {
  return { kind: 'text', default: value, parse: (t) => t };
}

function number(value: number): ParamSpec<number> {
  return {
    kind: 'number', default: value,
    parse: (t) => {
      const n = Number(t);
      if (t.trim() === '' || !Number.isFinite(n)) throw new Error(`"${t}" is not a number.`);
      return n;
    },
  };
}

function bool(value: boolean): ParamSpec<boolean> {
  return {
    kind: 'bool', default: value,
    parse: (t) => {
      if (t === 'true' || t === '1') return true;
      if (t === 'false' || t === '0') return false;
      throw new Error(`"${t}" is not true or false.`);
    },
  };
}

function isoDate(value: string): ParamSpec<string> {
  const check = (t: string) => {
    if (!ISO_DATE.test(t) || Number.isNaN(Date.parse(`${t}T00:00:00Z`)) || new Date(`${t}T00:00:00Z`).toISOString().slice(0, 10) !== t) {
      throw new Error(`"${t}" is not a date written YYYY-MM-DD.`);
    }
    return t;
  };
  check(value);
  return { kind: 'isoDate', default: value, parse: check };
}

export interface ParamFunction {
  <S extends Record<string, ParamSpec<unknown>>>(specs: S): Values<S>;
  /** One of these strings. The value's type is their union. */
  choice: typeof choice;
  text: typeof text;
  number: typeof number;
  bool: typeof bool;
  /** A date as `YYYY-MM-DD` text: what SQL compares and a date input gives. */
  isoDate: typeof isoDate;
}

/** A param() that finds each value with `resolve`. */
export function createParam(resolve: ParamResolver): ParamFunction {
  const fn = <S extends Record<string, ParamSpec<unknown>>>(specs: S): Values<S> => {
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(specs)) out[name] = resolve(name, spec);
    return Object.freeze(out) as Values<S>;
  };
  return Object.assign(fn, { choice, text, number, bool, isoDate });
}

/** Declares the notebook's parameters. Outside a running notebook, each takes its default. */
export const param: ParamFunction = createParam((_name, spec) => spec.default);

/** A value as text, as the page and URLs carry it. */
export function paramText(value: unknown): string {
  return String(value);
}
