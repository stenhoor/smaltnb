// The notebook page in headless Chromium: builds the app, serves it, and drives it. Needs Playwright, which isn't a
// project dependency: install it outside the project and point NODE_PATH at it (an npm install in the project would
// remove the packages `npm run deps` installs):
//
//   npm install --prefix ~/.pw playwright && ~/.pw/node_modules/.bin/playwright install chromium
//   NODE_PATH=~/.pw/node_modules npm run e2e
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// require, not import: it also finds a Playwright installed globally (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');

const port = 8091;
execFileSync('node', ['scripts/build-app.mjs', 'dist-app'], { stdio: 'inherit' });
const server = spawn('node', ['scripts/serve-app.mjs', 'dist-app', String(port)], { stdio: 'ignore' });
const browser = await chromium.launch();
let failed = false;

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed = true;
    console.log(`not ok - ${name}\n  ${String(err?.stack ?? err).split('\n').join('\n  ')}`);
  }
};

try {
  await new Promise((r) => setTimeout(r, 300));
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const status = (id) => page.evaluate((id) => document.querySelector(`[data-cell="${id}"]`)?.dataset.status, id);
  const until = (id, s, timeout = 30000) => page.waitForFunction(([id, s]) => document.querySelector(`[data-cell="${id}"]`)?.dataset.status === s, [id, s], { timeout });
  const cellText = (id) => page.evaluate((id) => document.querySelector(`[data-cell="${id}"] textarea`).value, id);
  const setCell = async (id, text) => {
    await page.evaluate(([id, text]) => {
      const ta = document.querySelector(`[data-cell="${id}"] textarea`);
      ta.value = text;
      ta.dispatchEvent(new Event('input'));
    }, [id, text]);
  };
  const gridRows = (id) => page.evaluate((id) => [...document.querySelectorAll(`[data-cell="${id}"] tbody tr[data-row]:not(.sk-grid-loading)`)]
    .map((tr) => [...tr.querySelectorAll('td[data-col]')].map((td) => td.textContent)), id);

  await page.goto(`http://localhost:${port}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await step('the demo notebook opens and runs: every cell ok, the action waits', async () => {
    await until('byRegion', 'ok');
    assert.equal(await status('orders'), 'ok');
    assert.equal(await status('save totals'), 'idle');
    assert.deepEqual((await gridRows('byRegion')).map((r) => r[0]), ['east', 'west', 'south', 'north']);
  });

  await step('a chart cell draws its result with smaltkit/charts: a bar per region, labelled', async () => {
    await until('revenueChart', 'ok');
    await page.waitForSelector('[data-cell="revenueChart"] .chart svg [data-row]');
    const bars = await page.$$eval('[data-cell="revenueChart"] .chart svg [data-row]', (els) => new Set(els.map((e) => e.getAttribute('data-row'))).size);
    assert.equal(bars, 4);
    const text = await page.textContent('[data-cell="revenueChart"] .chart');
    for (const region of ['north', 'south', 'east', 'west']) assert.ok(text.includes(region), region);
  });

  await step('controls (ui.*) show under their cell; a change reruns it with the new value', async () => {
    await until('bigOrders', 'ok');
    const count = () => page.evaluate(() => document.querySelector('[data-cell="bigOrders"] .table-foot span')?.textContent ?? '');
    const at1000 = await count();
    assert.equal(await page.$$eval('[data-cell="bigOrders"] .controls .control', (els) => els.length), 2);
    // The slider: lower the threshold, and more orders come back.
    await page.evaluate(() => {
      const input = document.querySelector('[data-cell="bigOrders"] .control-slider input');
      input.value = '200';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction((b) => {
      const t = document.querySelector('[data-cell="bigOrders"] .table-foot span')?.textContent;
      return !!t && t !== b;
    }, at1000, { timeout: 30000 });
    assert.equal(await page.textContent('[data-cell="bigOrders"] .control-slider output'), '200');
    // The select: a chip per region; picking one keeps only its orders.
    await page.click('[data-cell="bigOrders"] .control-select .sk-chip:has-text("north")');
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-cell="bigOrders"] tbody tr[data-row] td[data-col="1"]')].map((td) => td.textContent);
      return rows.length > 0 && rows.every((r) => r === 'north');
    }, null, { timeout: 30000 });
    assert.equal(await page.textContent('[data-cell="bigOrders"] .control-select .sk-chip.sk-on'), 'north');
  });

  await step('the graph view: a box per cell, coloured by status, an arrow per read; a click goes to the cell', async () => {
    await page.click('#graph');
    await page.waitForSelector('#graph-panel svg g.node');
    const nodes = await page.$$eval('#graph-panel g.node', (els) => els.map((e) => [e.dataset.node, e.dataset.status]));
    const cells = await page.$$eval('.cell', (els) => els.map((e) => e.dataset.cell).filter((id) => id !== 'setup'));
    assert.deepEqual(nodes.map((n) => n[0]).sort(), [...cells].sort(), 'every cell but setup');
    assert.deepEqual(nodes.find((n) => n[0] === 'byRegion'), ['byRegion', 'ok']);
    assert.deepEqual(nodes.find((n) => n[0] === 'save totals'), ['save totals', 'idle']);
    const edges = await page.$$eval('#graph-panel path.edge', (els) => els.map((e) => `${e.dataset.from}>${e.dataset.to}`));
    for (const e of ['params>orders', 'orders>byRegion', 'byRegion>revenueChart', 'orders>bigOrders', 'byRegion>save totals']) assert.ok(edges.includes(e), e);
    // Depth: byRegion sits to the right of orders.
    const x = (id) => page.$eval(`#graph-panel g.node[data-node="${id}"]`, (g) => g.getBoundingClientRect().x);
    assert.ok((await x('byRegion')) > (await x('orders')));
    await page.hover('#graph-panel g.node[data-node="orders"]');
    assert.ok(await page.$eval('#graph-panel svg', (s) => s.classList.contains('focus')));
    assert.ok(await page.$eval('#graph-panel g.node[data-node="byRegion"]', (g) => g.classList.contains('near')));
    await page.click('#graph-panel g.node[data-node="bigOrders"]');
    await page.waitForFunction(() => {
      const r = document.querySelector('.cell[data-cell="bigOrders"]').getBoundingClientRect();
      return r.top >= 0 && r.top < innerHeight;
    }, null, { timeout: 5000 });
    // Open stays open across a reload; then close it.
    await page.reload();
    await page.waitForSelector('#graph-panel:not([hidden]) svg g.node');
    await until('byRegion', 'ok');
    await page.click('#graph');
    assert.equal(await page.$eval('#graph-panel', (e) => e.hidden), true);
  });

  await step('type errors are warnings: marked in the cell they are in, and the notebook still runs', async () => {
    const marks = (id) => page.evaluate((id) => [...document.querySelectorAll(`[data-cell="${id}"] mark.sk-ed-warn`)].map((m) => [m.textContent, m.title]), id);
    const allMarks = () => page.evaluate(() => document.querySelectorAll('mark.sk-ed-warn').length);
    const shown = (snippet, present = true) =>
      page.waitForFunction(([s, p]) => (document.body.dataset.checked ?? null) !== null && document.body.dataset.checked.includes(s) === p, [snippet, present], { timeout: 20000 });
    // The demo, as written: checked, no warnings.
    await shown('.filter(');
    assert.equal(await allMarks(), 0);
    // A misspelt method in one cell: marked there, with tsc's message and its line in the gutter.
    const orders = await cellText('orders');
    await setCell('orders', orders.replace('.filter(', '.fliter('));
    await shown('.fliter(');
    assert.deepEqual(await marks('orders'), [['fliter', "Property 'fliter' does not exist on type 'Frame'. Did you mean 'filter'?"]]);
    assert.equal(await allMarks(), 1);
    const line = orders.slice(0, orders.indexOf('.filter(')).split('\n').length;
    assert.equal(await page.evaluate((id) => document.querySelector(`[data-cell="${id}"] .sk-ed-warnline`)?.textContent, 'orders'), String(line));
    // Fixed: no marks, and the notebook runs as before.
    await setCell('orders', orders);
    await shown('.fliter(', false);
    assert.equal(await allMarks(), 0);
    await until('byRegion', 'ok');
  });

  await step('an edit reruns what follows it', async () => {
    const before = await gridRows('byRegion');
    await setCell('params', (await cellText('params')).replace('param.number(1)', 'param.number(5)'));
    await page.waitForFunction((b) => {
      const rows = [...document.querySelectorAll('[data-cell="byRegion"] tbody tr[data-row] td[data-col="1"]')].map((td) => td.textContent);
      return rows.length > 0 && JSON.stringify(rows) !== b;
    }, JSON.stringify(before.map((r) => r[1])), { timeout: 30000 });
    assert.equal(await status('byRegion'), 'ok');
  });

  await step('the params bar sets a parameter: what reads it reruns, and the value goes into the URL', async () => {
    const qty = await page.inputValue('#params input[name="minQty"]');
    assert.equal(qty, '5', 'the bar shows the default from the edited source');
    const before = JSON.stringify(await gridRows('byRegion'));
    await page.fill('#params input[name="minQty"]', '3');
    await page.dispatchEvent('#params input[name="minQty"]', 'change');
    await page.waitForFunction((b) => {
      const rows = [...document.querySelectorAll('[data-cell="byRegion"] tbody tr[data-row]')].map((tr) => [...tr.querySelectorAll('td[data-col]')].map((td) => td.textContent));
      return rows.length > 0 && JSON.stringify(rows) !== b;
    }, before, { timeout: 30000 });
    assert.match(page.url(), /[?&]minQty=3\b/);
    await page.fill('#params input[name="minQty"]', '5');
    await page.dispatchEvent('#params input[name="minQty"]', 'change');
    await page.waitForFunction(() => !location.search.includes('minQty'));
  });

  await step('a write in a plain cell is held, and runs from its button', async () => {
    const before = await page.evaluate(() => document.querySelectorAll('.cell').length);
    await page.click('#add-cell');
    await page.waitForFunction((n) => document.querySelectorAll('.cell').length === n + 1, before);
    const id = await page.evaluate(() => [...document.querySelectorAll('.cell')].at(-1).dataset.cell);
    await setCell(id, `cell('${id}');\nawait exec\`INSERT INTO region_totals VALUES ('test', 1)\`;`);
    await until(id, 'held');
    assert.match(await page.textContent(`[data-cell="${id}"] .reason`), /writes to the database/);
    await page.click(`[data-cell="${id}"] .actions button`);
    await until(id, 'ok');
  });

  await step('an action runs from its button', async () => {
    await page.click('[data-cell="save totals"] .actions button');
    await until('save totals', 'ok');
  });

  await step('a large result: the grid fetches rows as it scrolls', async () => {
    const id = await page.evaluate(() => [...document.querySelectorAll('.cell')].at(-1).dataset.cell);
    await setCell(id, `cell('${id}');\nexport const all = sql\`SELECT * FROM orders ORDER BY id\`;\nall;`);
    await until(id, 'ok');
    assert.match(await page.textContent(`[data-cell="${id}"] .table-foot`), /2,000 rows/);
    await page.evaluate((id) => { document.querySelector(`[data-cell="${id}"] .sk-grid-scroll`).scrollTop = 26 * 1500; }, id);
    await page.waitForFunction((id) => [...document.querySelectorAll(`[data-cell="${id}"] tbody tr[data-row]:not(.sk-grid-loading) td[data-col="0"]`)]
      .some((td) => Number(td.textContent) > 1400), id, { timeout: 15000 });
  });

  await step('a plain SQL cell shows only its SQL; TS shows the TypeScript it is saved as', async () => {
    const sqlOnly = await cellText('byRegion');
    assert.match(sqlOnly, /^SELECT region, sum\(revenue\) AS revenue FROM \$\{orders\}/);
    assert.doesNotMatch(sqlOnly, /cell\(|export const|sql</);
    await page.click('[data-cell="byRegion"] .view-toggle');
    assert.match(await cellText('byRegion'), /^cell\('byRegion', \{ lang: 'sql' \}\);\nexport const byRegion = sql<\{ region: string; revenue: number \}>`/);
    await page.click('[data-cell="byRegion"] .view-toggle');
    assert.match(await cellText('byRegion'), /^SELECT region/);
  });

  await step('editing the SQL reruns the cell, and the file keeps its TypeScript form', async () => {
    await setCell('byRegion', (await cellText('byRegion')).replace('ORDER BY revenue DESC', 'ORDER BY revenue ASC'));
    await page.waitForFunction(() => {
      const cells = [...document.querySelectorAll('[data-cell="byRegion"] tbody tr[data-row] td[data-col="1"]')].map((td) => Number(td.textContent));
      return cells.length > 1 && cells[0] <= cells[cells.length - 1];
    }, null, { timeout: 30000 });
    await page.click('#source');
    const file = await page.evaluate(() => document.querySelector('.source-editor textarea').value);
    assert.match(file, /export const byRegion = sql<\{ region: string; revenue: number \}>`SELECT region, sum\(revenue\) AS revenue FROM \$\{orders\} GROUP BY region ORDER BY revenue ASC`;\nbyRegion;/);
    await page.click('#source');
    await page.waitForSelector('[data-cell="byRegion"]');
  });

  await step('+ SQL adds a SQL cell, named after its result, that runs', async () => {
    const before = await page.evaluate(() => document.querySelectorAll('.cell').length);
    await page.click('#add-sql');
    await page.waitForFunction((n) => document.querySelectorAll('.cell').length === n + 1, before);
    const id = await page.evaluate(() => [...document.querySelectorAll('.cell')].at(-1).dataset.cell);
    assert.match(id, /^query\d+$/);
    assert.equal(await cellText(id), 'SELECT 1 AS one');
    await until(id, 'ok');
    assert.deepEqual(await gridRows(id), [['1']]);
  });

  await step('Pin types writes the result\'s row type into a SQL cell; after an edit, Update types brings it up to date', async () => {
    const id = await page.evaluate(() => [...document.querySelectorAll('.cell')].at(-1).dataset.cell);
    const pin = `[data-cell="${id}"] .actions button:has-text("Pin types")`;
    await page.waitForSelector(pin);
    await page.click(pin);
    // The SQL stays as it was; the TypeScript it is saved as now has the type.
    await page.waitForFunction((id) => !document.querySelector(`[data-cell="${id}"] .actions button`)?.textContent?.includes('Pin types'), id);
    assert.equal(await cellText(id), 'SELECT 1 AS one');
    await page.click(`[data-cell="${id}"] .view-toggle`);
    assert.match(await cellText(id), /export const \w+ = sql<\{ one: number \}>`SELECT 1 AS one`;/);
    await page.click(`[data-cell="${id}"] .view-toggle`);
    // A new column: the pinned type no longer matches the run.
    await setCell(id, "SELECT 1 AS one, 'a' AS two");
    await page.waitForSelector(`[data-cell="${id}"] .types-warn`, { timeout: 30000 });
    assert.match(await page.getAttribute(`[data-cell="${id}"] .types-warn`, 'title'), /the result has "two", which the type doesn't/);
    await page.click(`[data-cell="${id}"] .actions button:has-text("Update types")`);
    await page.waitForFunction((id) => !document.querySelector(`[data-cell="${id}"] .types-warn`), id, { timeout: 30000 });
    await page.click(`[data-cell="${id}"] .view-toggle`);
    assert.match(await cellText(id), /sql<\{ one: number; two: string \}>/);
    await page.click(`[data-cell="${id}"] .view-toggle`);
  });

  await step('a text cell shows its Markdown to edit and renders it below; + Text adds one', async () => {
    assert.match(await cellText('intro'), /^# Shop analysis\nRevenue by region from the \*\*orders\*\* table/);
    assert.equal(await page.textContent('[data-cell="intro"] .markdown h1'), 'Shop analysis');
    assert.equal(await page.textContent('[data-cell="intro"] .markdown strong'), 'orders');
    await setCell('intro', '# Shop\n<b>not html</b> and `code`');
    await page.waitForFunction(() => document.querySelector('[data-cell="intro"] .markdown h1')?.textContent === 'Shop');
    assert.equal(await page.textContent('[data-cell="intro"] .markdown code'), 'code');
    assert.equal(await page.$('[data-cell="intro"] .markdown b'), null, 'raw HTML shows as text');
    const before = await page.evaluate(() => document.querySelectorAll('.cell').length);
    await page.click('#add-md');
    await page.waitForFunction((n) => document.querySelectorAll('.cell').length === n + 1, before);
    const id = await page.evaluate(() => [...document.querySelectorAll('.cell')].at(-1).dataset.cell);
    await until(id, 'ok');
    assert.equal(await page.textContent(`[data-cell="${id}"] .markdown strong`), 'Markdown');
  });

  // Last: its Run all also starts the cell that never finishes, which keeps the kernel busy.
  await step('a repository folder: open a notebook from it, save back to it, and see each cell against the last commit', async () => {
    // A git repository made with the git command, with the demo notebook committed. The page gets it as a folder from
    // the browser's own storage (OPFS), in place of the folder picker a person would use: the same directory handle.
    const repo = mkdtempSync(join(tmpdir(), 'smaltnb-repo-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.org', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.org', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const git = (...args) => execFileSync('git', args, { cwd: repo, env });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'nb'));
    writeFileSync(join(repo, 'nb/shop.nb.ts'), readFileSync('examples/shop.nb.ts', 'utf8'));
    git('add', '-A');
    git('commit', '-q', '-m', 'the shop notebook');
    git('gc', '-q');
    const files = [];
    const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else files.push(relative(repo, f)); } };
    walk(repo);
    await page.route('**/__fixture/**', (r) => r.fulfill({ body: readFileSync(join(repo, decodeURIComponent(new URL(r.request().url()).pathname.slice('/__fixture/'.length)))) }));
    await page.evaluate(async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('shop-repo', { create: true });
      for (const f of files) {
        const parts = f.split('/');
        let d = root;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(await (await fetch(`/__fixture/${encodeURIComponent(f).replace(/%2F/g, '/')}`)).arrayBuffer());
        await w.close();
      }
      window.showDirectoryPicker = async () => root;
    }, files);

    await page.click('#folder');
    await page.waitForFunction(() => [...document.querySelectorAll('#folder-file option')].some((o) => o.value === 'nb/shop.nb.ts'));
    await page.selectOption('#folder-file', 'nb/shop.nb.ts');
    await until('byRegion', 'ok');
    await page.waitForFunction(() => document.querySelector('#git-status')?.textContent === 'on main · no changes since the last commit');
    assert.equal(await page.$$eval('.change-chip', (els) => els.length), 0, 'nothing has changed yet');

    // An edit: saved to the folder's file, and the cell is marked changed, with its diff.
    await setCell('params', (await cellText('params')).replace('param.number(1)', 'param.number(2)'));
    await page.waitForFunction(() => document.querySelector('#git-status')?.textContent === 'on main · changed since the last commit', null, { timeout: 30000 });
    assert.equal(await page.textContent('.cell[data-cell="params"] .change-chip'), 'changed');
    assert.equal(await page.$$eval('.change-chip', (els) => els.length), 1, 'only that cell');
    await page.click('.cell[data-cell="params"] .diff-toggle');
    const diff = await page.$$eval('.cell[data-cell="params"] .diff span', (els) => els.map((e) => `${e.className}:${e.textContent.trim()}`));
    assert.ok(diff.includes('remove:- export const params = param({ minQty: param.number(1) });'), diff.join('\n'));
    assert.ok(diff.includes('add:+ export const params = param({ minQty: param.number(2) });'), diff.join('\n'));
    const saved = await page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('shop-repo');
      return (await (await (await root.getDirectoryHandle('nb')).getFileHandle('shop.nb.ts')).getFile()).text();
    });
    assert.match(saved, /param\.number\(2\)/, 'the file in the folder has the edit');

    // A new cell is marked new.
    await page.click('#add-cell');
    await page.waitForFunction(() => document.querySelectorAll('.change-chip.new').length === 1, null, { timeout: 30000 });
    // The folder is remembered for the next visit (its handle in IndexedDB; listing the keys loads no handle). Reopening
    // it isn't driven here: this headless Chromium closes the page when an OPFS handle is read back from IndexedDB.
    assert.deepEqual(await page.evaluate(() => new Promise((resolve) => {
      const q = indexedDB.open('smaltnb-folder');
      q.onsuccess = () => { const g = q.result.transaction('handles').objectStore('handles').getAllKeys(); g.onsuccess = () => resolve(g.result); };
    })), ['last']);

    // Back to a notebook outside the folder: no marks.
    await page.click('#demo');
    await until('byRegion', 'ok');
    assert.equal(await page.$$eval('.change-chip', (els) => els.length), 0);
    await page.waitForFunction(() => document.querySelector('#git-status')?.textContent === 'on main', null, { timeout: 10000 });
    // Forget the folder, so a later reload in these steps doesn't read the stored handle back (see above).
    await page.evaluate(() => new Promise((resolve) => { const d = indexedDB.deleteDatabase('smaltnb-folder'); d.onsuccess = d.onerror = d.onblocked = resolve; }));
  });

  await step('a cell\'s history: the commits that changed it, each one\'s diff, blame, and Use this version', async () => {
    // Three commits: the notebook; params changed; only the intro changed (params' history skips it).
    const repo = mkdtempSync(join(tmpdir(), 'smaltnb-hist-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.org', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.org', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const git = (...args) => execFileSync('git', args, { cwd: repo, env });
    const shop = readFileSync('examples/shop.nb.ts', 'utf8');
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'shop.nb.ts'), shop);
    git('add', '-A');
    git('commit', '-q', '-m', 'the shop notebook');
    writeFileSync(join(repo, 'shop.nb.ts'), shop.replace('param.number(1)', 'param.number(3)'));
    git('commit', '-qam', 'minQty 3 by default');
    writeFileSync(join(repo, 'shop.nb.ts'), shop.replace('param.number(1)', 'param.number(3)').replace('# Shop analysis', '# Shop'));
    git('commit', '-qam', 'shorter title');
    const second = execFileSync('git', ['rev-parse', '--short=7', 'HEAD~1'], { cwd: repo, encoding: 'utf8' }).trim();
    const files = [];
    const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else files.push(relative(repo, f)); } };
    walk(repo);
    await page.unroute('**/__fixture/**');
    await page.route('**/__fixture/**', (r) => r.fulfill({ body: readFileSync(join(repo, decodeURIComponent(new URL(r.request().url()).pathname.slice('/__fixture/'.length)))) }));
    await page.evaluate(async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('hist-repo', { create: true });
      for (const f of files) {
        const parts = f.split('/');
        let d = root;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(await (await fetch(`/__fixture/${encodeURIComponent(f).replace(/%2F/g, '/')}`)).arrayBuffer());
        await w.close();
      }
      window.showDirectoryPicker = async () => root;
    }, files);
    await page.click('#folder');
    await page.waitForFunction(() => [...document.querySelectorAll('#folder-file option')].some((o) => o.value === 'shop.nb.ts'));
    await page.selectOption('#folder-file', 'shop.nb.ts');
    await until('byRegion', 'ok');
    await page.waitForFunction(() => document.querySelector('#git-status')?.textContent === 'on main · no changes since the last commit', null, { timeout: 30000 });

    await page.click('.cell[data-cell="params"] .history-toggle');
    await page.waitForSelector('.cell[data-cell="params"] .history-row');
    const rows = await page.$$eval('.cell[data-cell="params"] .history-row', (els) => els.map((e) => e.textContent));
    assert.equal(rows.length, 2, rows.join('\n'));
    assert.match(rows[0], new RegExp(`^${second} · \\d{4}-\\d{2}-\\d{2} · Ada · minQty 3 by default$`));
    assert.match(rows[1], /· the shop notebook \(added the cell\)$/);
    await page.click('.cell[data-cell="params"] .history-row >> nth=0');
    const diff = await page.$$eval('.cell[data-cell="params"] .history-detail .diff span', (els) => els.map((e) => `${e.className}:${e.textContent.trim()}`));
    assert.ok(diff.includes('remove:- export const params = param({ minQty: param.number(1) });'), diff.join('\n'));
    assert.ok(diff.includes('add:+ export const params = param({ minQty: param.number(3) });'), diff.join('\n'));

    await page.click('.cell[data-cell="params"] .blame-toggle');
    await page.waitForSelector('.cell[data-cell="params"] .blame');
    const blame = await page.textContent('.cell[data-cell="params"] .blame');
    assert.match(blame, new RegExp(`${second} Ada\\s+ export const params = param\\(\\{ minQty: param\\.number\\(3\\) \\}\\);`), blame);
    assert.doesNotMatch(blame.split('\n')[0], new RegExp(second), 'the cell() line is older');

    // Use this version: the first commit's params come back, in the editor and the folder's file.
    await page.click('.cell[data-cell="params"] .history-row >> nth=1');
    await page.click('.cell[data-cell="params"] .history-detail >> nth=1 >> button:has-text("Use this version")');
    await page.waitForFunction(() => document.querySelector('.cell[data-cell="params"] textarea')?.value.includes('param.number(1)'), null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('.cell[data-cell="params"] .change-chip')?.textContent === 'changed', null, { timeout: 30000 });
    const saved = await page.evaluate(async () => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('hist-repo')).getFileHandle('shop.nb.ts')).getFile()).text());
    assert.match(saved, /param\.number\(1\)/);
    await page.click('#demo');
    await until('byRegion', 'ok');
    await page.evaluate(() => new Promise((resolve) => { const d = indexedDB.deleteDatabase('smaltnb-folder'); d.onsuccess = d.onerror = d.onblocked = resolve; }));
  });

  await step('merge conflicts by cell: only the cells that differ are offered, and saving writes a clean file', async () => {
    // A real conflict, made with git: ours sets minQty to 3; theirs sets it to 5 and adds a cell, which merges cleanly.
    const repo = mkdtempSync(join(tmpdir(), 'smaltnb-merge-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.org', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.org', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' });
    const shop = readFileSync('examples/shop.nb.ts', 'utf8');
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'shop.nb.ts'), shop);
    git('add', '-A');
    git('commit', '-q', '-m', 'the shop notebook');
    git('checkout', '-q', '-b', 'other');
    writeFileSync(join(repo, 'shop.nb.ts'), shop.replace('param.number(1)', 'param.number(5)') + "\ncell('extra');\nexport const extra = 42;\n");
    git('commit', '-qam', 'minQty 5, and an extra cell');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'shop.nb.ts'), shop.replace('param.number(1)', 'param.number(3)'));
    git('commit', '-qam', 'minQty 3');
    assert.throws(() => git('merge', '-q', 'other'), 'the merge conflicts');
    assert.match(readFileSync(join(repo, 'shop.nb.ts'), 'utf8'), /^<<<<<<< HEAD$/m);
    const files = [];
    const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else files.push(relative(repo, f)); } };
    walk(repo);
    await page.unroute('**/__fixture/**');
    await page.route('**/__fixture/**', (r) => r.fulfill({ body: readFileSync(join(repo, decodeURIComponent(new URL(r.request().url()).pathname.slice('/__fixture/'.length)))) }));
    await page.evaluate(async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('merge-repo', { create: true });
      for (const f of files) {
        const parts = f.split('/');
        let d = root;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(await (await fetch(`/__fixture/${encodeURIComponent(f).replace(/%2F/g, '/')}`)).arrayBuffer());
        await w.close();
      }
      window.showDirectoryPicker = async () => root;
    }, files);
    await page.click('#folder');
    // The folder before this one also had a shop.nb.ts: wait for this folder's list.
    await page.waitForFunction(() => document.querySelector('#folder')?.textContent === 'merge-repo/');
    await page.selectOption('#folder-file', 'shop.nb.ts');

    await page.waitForSelector('.resolver');
    assert.match(await page.textContent('.resolver > p'), /^This notebook has 1 merge conflict between HEAD \(ours\) and other \(theirs\)\. 1 cell differs/);
    assert.deepEqual(await page.$$eval('.resolve-cell', (els) => els.map((e) => e.dataset.cell)), ['params'], 'extra merged cleanly: not offered');
    const [ours, theirs] = await page.$$eval('.resolve-cell[data-cell="params"] pre', (els) => els.map((e) => e.textContent));
    assert.match(ours, /param\.number\(3\)/);
    assert.match(theirs, /param\.number\(5\)/);
    assert.equal(await page.$eval('.resolver-foot button', (b) => b.disabled), true, 'nothing chosen yet');
    await page.click('.resolve-cell[data-cell="params"] button:has-text("Keep theirs")');
    assert.equal(await page.textContent('.resolver-left'), 'Ready to save');
    await page.click('.resolver-foot button');

    await until('byRegion', 'ok');
    assert.match(await cellText('params'), /param\.number\(5\)/);
    assert.ok(await page.$('.cell[data-cell="extra"]'), 'the cell theirs added is there');
    const saved = await page.evaluate(async () => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('merge-repo')).getFileHandle('shop.nb.ts')).getFile()).text());
    assert.doesNotMatch(saved, /^(<{7}|={7}|>{7})/m, 'no markers left');
    assert.match(saved, /param\.number\(5\)/);
    assert.match(saved, /cell\('extra'\)/);
    await page.click('#demo');
    await until('byRegion', 'ok');
    await page.evaluate(() => new Promise((resolve) => { const d = indexedDB.deleteDatabase('smaltnb-folder'); d.onsuccess = d.onerror = d.onblocked = resolve; }));
  });

  await step('restart stops a cell that never finishes; the cells can run again', async () => {
    const before = await page.evaluate(() => document.querySelectorAll('.cell').length);
    await page.click('#add-cell');
    await page.waitForFunction((n) => document.querySelectorAll('.cell').length === n + 1, before);
    const id = await page.evaluate(() => [...document.querySelectorAll('.cell')].at(-1).dataset.cell);
    await setCell(id, `cell('${id}', { run: 'manual' });\nwhile (true) {}`);
    await page.waitForFunction((id) => document.querySelector(`[data-cell="${id}"] .actions button`), id);
    await page.click(`[data-cell="${id}"] .actions button`);
    await until(id, 'running');
    await page.click('#restart');
    await until('byRegion', 'idle');
    assert.match(await page.textContent('[data-cell="byRegion"] .reason'), /the kernel was restarted/);
    await page.click('#run-all');
    await until('byRegion', 'ok');
  });

  await step('no page errors', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
