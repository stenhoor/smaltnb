// The editor language for plain SQL cells: smaltkit's SQL, with `${name}` references to other cells' results marked.
import { sqlLanguage, type EditorLanguage } from 'smaltkit/editor';
import { highlight } from 'smaltkit/sql';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SQL with references: text between `${…}` is highlighted as SQL, each reference as one marked token. */
function highlightWithRefs(text: string): string {
  let html = '';
  let at = 0;
  for (const m of text.matchAll(/\$\{[^}\n]*\}?/g)) {
    html += highlight(text.slice(at, m.index)).slice(0, -1);
    html += `<span class="sk-tk-interp" title="Another cell's result">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return html + highlight(text.slice(at));
}

export const sqlCellLanguage: EditorLanguage = {
  ...sqlLanguage,
  name: 'SQL',
  highlight: highlightWithRefs,
};
