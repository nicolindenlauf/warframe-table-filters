#!/usr/bin/env node
/**
 * Proper Playwright test for the Warframe Wiki Table Filters userscript.
 * Uses the installed Playwright library and drives the filters like a user:
 * it opens the reference page, injects the userscript, and interacts with
 * from/to range inputs for numeric and date columns.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('/home/nicol/playwright-test/node_modules/playwright');

const USERSCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'warframe-wiki-table-filters.user.js'),
  'utf8'
);
const URL = 'https://wiki.warframe.com/w/Weapon_Comparison/Melee';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name} (${Date.now() - start}ms)`);
    console.error(err && err.stack ? err.stack : err);
  }
}

async function loadPageWithFilters(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('table.wikitable.sortable thead th', { timeout: 60000 });
  await page.addScriptTag({ content: USERSCRIPT });
  await page.waitForSelector('.wf-filter-controls', { timeout: 30000 });
}

async function mainTable(page) {
  const table = page.locator('table.wikitable.sortable')
    .filter({ has: page.locator('thead th', { hasText: 'Introduced' }) })
    .filter({ has: page.locator('thead th', { hasText: 'MR' }) })
    .first();
  await table.waitFor({ state: 'visible', timeout: 30000 });
  return table;
}

function getCount(text) {
  const m = text.match(/Showing (\d+) of (\d+) rows/);
  assert(m, `count text not recognized: ${text}`);
  return { shown: Number(m[1]), total: Number(m[2]) };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    await test('injects range filter UI on the reference table', async () => {
      await loadPageWithFilters(page);
      const table = await mainTable(page);
      const controls = table.locator('.wf-filter-controls');
      await controls.waitFor();
      const controlsText = await controls.innerText();
      assert.match(controlsText, /Filters/);
      const count = getCount(await table.locator('.wf-filter-count').innerText());
      assert.ok(count.total > 100, `expected large table, got total ${count.total}`);
      assert.equal(count.shown, count.total, 'all rows should be visible initially');
      const numInputs = await table.locator('.wf-filter-row input[type="number"]').count();
      assert.ok(numInputs >= 5, `expected >=5 numeric range inputs, got ${numInputs}`);
      const dateInputs = await table.locator('.wf-filter-row input[type="date"]').count();
      assert.ok(dateInputs >= 1, `expected >=1 date range input, got ${dateInputs}`);
      // inputs should have placeholders like a user expects
      assert.ok(await table.locator('.wf-filter-row input[placeholder="From"]').count() >= 5);
      assert.ok(await table.locator('.wf-filter-row input[placeholder="To"]').count() >= 5);
    });

    await test('filters a numeric column by From/To (user interaction) and clears', async () => {
      // reuse page; clear any state
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForSelector('table.wikitable.sortable thead th', { timeout: 60000 });
      await page.addScriptTag({ content: USERSCRIPT });
      await page.waitForSelector('.wf-filter-controls', { timeout: 30000 });
      const table = await mainTable(page);
      const initial = getCount(await table.locator('.wf-filter-count').innerText());

      const mrCol = await table.evaluate((t) => {
        const headerRows = Array.from(t.querySelectorAll('thead tr'))
          .filter(r => !r.classList.contains('wf-filter-row') && !r.classList.contains('wf-filter-controls'));
        const headers = Array.from(headerRows[0].children).map(th => th.innerText.replace(/\s+/g, ' ').trim());
        return headers.findIndex(h => /^MR$/i.test(h));
      });
      assert.ok(mrCol >= 0, 'MR column not found');

      const from = table.locator('.wf-filter-row > *').nth(mrCol).locator('input[placeholder="From"]');
      const to = table.locator('.wf-filter-row > *').nth(mrCol).locator('input[placeholder="To"]');
      await from.click();
      await from.fill('12');
      await page.waitForTimeout(350);

      const afterFrom = getCount(await table.locator('.wf-filter-count').innerText());
      assert.ok(afterFrom.shown > 0, 'filter should leave some rows');
      assert.ok(afterFrom.shown < initial.total, `MR>=12 should reduce rows (${afterFrom.shown} !< ${initial.total})`);

      const badLow = await table.evaluate((t, col) => {
        const rows = Array.from(t.tBodies[0].rows).filter(r => r.style.display !== 'none' && r.querySelector('td'));
        for (const r of rows) {
          const txt = (r.children[col]?.innerText || '').replace(/,/g, '');
          const m = txt.match(/-?\d+(?:\.\d+)?/);
          if (!m || Number(m[0]) < 12) return txt;
        }
        return null;
      }, mrCol);
      assert.equal(badLow, null, `found visible row with MR < 12: ${badLow}`);

      await to.fill('13');
      await page.waitForTimeout(350);
      const afterTo = getCount(await table.locator('.wf-filter-count').innerText());
      assert.ok(afterTo.shown > 0);
      assert.ok(afterTo.shown <= afterFrom.shown);
      const badRange = await table.evaluate((t, col) => {
        const rows = Array.from(t.tBodies[0].rows).filter(r => r.style.display !== 'none' && r.querySelector('td'));
        for (const r of rows) {
          const n = Number(((r.children[col]?.innerText || '').match(/-?\d+(?:\.\d+)?/) || [])[0]);
          if (!(n >= 12 && n <= 13)) return n;
        }
        return null;
      }, mrCol);
      assert.equal(badRange, null, `found visible row outside MR 12-13: ${badRange}`);

      await table.locator('.wf-filter-clear').click();
      await page.waitForTimeout(350);
      const cleared = getCount(await table.locator('.wf-filter-count').innerText());
      assert.equal(cleared.shown, initial.total, 'clear should restore all rows');
      assert.equal(await from.inputValue(), '', 'From input should be cleared');
      assert.equal(await to.inputValue(), '', 'To input should be cleared');
    });

    await test('filters a date column (Introduced) by From date range', async () => {
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForSelector('table.wikitable.sortable thead th', { timeout: 60000 });
      await page.addScriptTag({ content: USERSCRIPT });
      await page.waitForSelector('.wf-filter-controls', { timeout: 30000 });
      const table = await mainTable(page);
      const initial = getCount(await table.locator('.wf-filter-count').innerText());

      const introCol = await table.evaluate((t) => {
        const headerRows = Array.from(t.querySelectorAll('thead tr'))
          .filter(r => !r.classList.contains('wf-filter-row') && !r.classList.contains('wf-filter-controls'));
        const headers = Array.from(headerRows[0].children).map(th => th.innerText.replace(/\s+/g, ' ').trim());
        return headers.findIndex(h => /^Introduced$/i.test(h));
      });
      assert.ok(introCol >= 0, 'Introduced column not found');

      const from = table.locator('.wf-filter-row > *').nth(introCol).locator('input[placeholder="From"]');
      const type = await from.getAttribute('type');
      assert.equal(type, 'date', 'Introduced filter should be a date input');
      await from.fill('2020-01-01');
      await page.waitForTimeout(350);

      const after = getCount(await table.locator('.wf-filter-count').innerText());
      assert.ok(after.shown > 0, 'date filter should leave some rows');
      assert.ok(after.shown < initial.total, 'date filter should reduce rows');
      const bad = await table.evaluate((t, col) => {
        const rows = Array.from(t.tBodies[0].rows).filter(r => r.style.display !== 'none' && r.querySelector('td'));
        for (const r of rows) {
          const txt = (r.children[col]?.innerText || '').trim();
          const m = txt.match(/\d{4}-\d{2}-\d{2}/);
          if (!m || m[0] < '2020-01-01') return txt;
        }
        return null;
      }, introCol);
      assert.equal(bad, null, `found visible row before 2020-01-01: ${bad}`);
    });

  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
