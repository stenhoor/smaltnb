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

  await step('an edit reruns what follows it', async () => {
    const before = await gridRows('byRegion');
    await setCell('params', (await cellText('params')).replace('minQty = 1', 'minQty = 5'));
    await page.waitForFunction((b) => {
      const rows = [...document.querySelectorAll('[data-cell="byRegion"] tbody tr[data-row] td[data-col="1"]')].map((td) => td.textContent);
      return rows.length > 0 && JSON.stringify(rows) !== b;
    }, JSON.stringify(before.map((r) => r[1])), { timeout: 30000 });
    assert.equal(await status('byRegion'), 'ok');
  });

  await step('a write in a plain cell is held, and runs from its button', async () => {
    await page.click('#add-cell');
    await page.waitForFunction(() => document.querySelectorAll('.cell').length === 6);
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

  await step('restart stops a cell that never finishes; the cells can run again', async () => {
    await page.click('#add-cell');
    await page.waitForFunction(() => document.querySelectorAll('.cell').length === 7);
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
