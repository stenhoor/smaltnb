// The editor language for plain Cypher cells: smaltkit's Cypher, with `${name}` references to other cells' results
// marked, as plain SQL cells mark them. Completion offers the notebook graph's labels, types and keys (the editor's
// schema `graph`, from the kernel).
import { cypherLanguage, type EditorLanguage } from 'smaltkit/editor';
import { highlightCypher } from 'smaltkit/cypher';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Cypher with references: text between `${…}` is highlighted as Cypher, each reference as one marked token. */
function highlightWithRefs(text: string): string {
  let html = '';
  let at = 0;
  for (const m of text.matchAll(/\$\{[^}\n]*\}?/g)) {
    html += highlightCypher(text.slice(at, m.index)).slice(0, -1);
    html += `<span class="sk-tk-interp" title="Another cell's result, or a value: a parameter">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return html + highlightCypher(text.slice(at));
}

export const cypherCellLanguage: EditorLanguage = {
  ...cypherLanguage,
  highlight: highlightWithRefs,
};
