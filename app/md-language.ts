// The editor language for Markdown cells: headings in the keyword colour, `${…}` (a notebook value) marked, the rest as
// written. Toggling a comment quotes the lines (`> `), Markdown's nearest thing.
import type { EditorLanguage } from 'smaltkit/editor';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlightMarkdown(text: string): string {
  const html = text.split('\n').map((line) => {
    const marked = esc(line).replace(/\$\{[^}\n]*\}?/g, (m) => `<span class="sk-tk-interp" title="A notebook value">${m}</span>`);
    return /^#{1,6}\s/.test(line) ? `<span class="sk-tk-k">${marked}</span>` : marked;
  });
  return html.join('\n') + '\n';
}

export const markdownLanguage: EditorLanguage = {
  name: 'Markdown',
  highlight: highlightMarkdown,
  lineComment: '>',
};
