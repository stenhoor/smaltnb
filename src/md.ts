// Markdown text in a notebook: md`…` gives a Markdown value, which the page shows rendered. `${value}` puts the value's
// text in, so prose can quote the notebook's values (`Orders of at least ${params.minQty}`); the renderer escapes it.

/** Markdown text, shown rendered as a cell's output. */
export class Markdown {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toString(): string {
    return this.text;
  }
}

/** The template's text as written (raw, like sql`…`): only \` and \${ are unescaped. */
const rawText = (s: string) => s.replace(/\\(`|\$(?=\{))/g, '$1');

/** Markdown text. */
export function md(strings: TemplateStringsArray, ...values: unknown[]): Markdown {
  const parts = strings.raw.map(rawText);
  let text = parts[0]!;
  values.forEach((v, i) => (text += String(v) + parts[i + 1]!));
  return new Markdown(text);
}
