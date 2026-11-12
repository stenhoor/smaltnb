// The notebook page in headless Chromium: builds the app, serves it, and drives it. Needs Playwright, which isn't a
// project dependency: install it outside the project and point NODE_PATH at it (an npm install in the project would
// remove the packages `npm run deps` installs):
//
//   npm install --prefix ~/.pw playwright && ~/.pw/node_modules/.bin/playwright install chromium
//   NODE_PATH=~/.pw/node_modules npm run e2e
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

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
