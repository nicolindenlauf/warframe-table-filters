// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const USERSCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'warframe-wiki-table-filters.user.js'),
  'utf8'
);
const URL = 'https://wiki.warframe.com/w/Weapon_Comparison/Melee';

async function loadPageWithFilters(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('table.wikitable.sortable thead th', { timeout: 60000 });
  await page.addScriptTag({ content: USERSCRIPT });
  // wait for enhancement
  await page.waitForSelector('.wf-filter-controls', { timeout: 30000 });
}

function mainTable(page) {
  // The large melee comparison table has "Introduced" and "MR" headers and hundreds of rows.
  return page.locator('table.wikitable.sortable').filter({ has: page.locator('thead th', { hasText: 'Introduced' }) }).filter({ has: page.locator('thead th', { hasText: 'MR' }) }).first();
}

async function visibleBodyRows(table) {
  return table.locator('tbody tr:visible');
}

test.describe('Warframe Wiki table range filters', () => {
  test('injects range filter UI on sortable wiki tables', async ({ page }) => {
    await loadPageWithFilters(page);
    const table = mainTable(page);
    await expect(table).toBeVisible();
    await expect(table.locator('.wf-filter-controls')).toContainText('Filters');
    const count = table.locator('.wf-filter-count');
    await expect(count).toContainText(/Showing \d+ of \d+ rows/);
    // Numeric columns like MR/Normal should get inputs
    const inputs = table.locator('.wf-filter-row input[type="number"]');
    expect(await inputs.count()).toBeGreaterThan(5);
    const dateInputs = table.locator('.wf-filter-row input[type="date"]');
    expect(await dateInputs.count()).toBeGreaterThanOrEqual(1);
  });

  test('filters a numeric column by from/to like a user', async ({ page }) => {
    await loadPageWithFilters(page);
    const table = mainTable(page);
    await expect(table.locator('.wf-filter-count')).toContainText(/Showing \d+ of \d+ rows/);

    const initialText = await table.locator('.wf-filter-count').innerText();
    const initialMatch = initialText.match(/of (\d+) rows/);
    expect(initialMatch).toBeTruthy();
    const initialTotal = Number(initialMatch[1]);
    expect(initialTotal).toBeGreaterThan(100);

    // Find MR column index by header text
    const mrCol = await table.evaluate((t) => {
      const ths = Array.from(t.querySelectorAll('thead tr:first-child th, thead th')).filter(th => !th.closest('.wf-filter-row,.wf-filter-controls'));
      // header structure after injection: controls, filter row, original header row
      const headerRows = Array.from(t.querySelectorAll('thead tr')).filter(r => !r.classList.contains('wf-filter-row') && !r.classList.contains('wf-filter-controls'));
      const real = headerRows[0];
      const headers = Array.from(real.children).map(th => th.innerText.replace(/\s+/g,' ').trim());
      return headers.findIndex(h => /^MR$/i.test(h));
    });
    expect(mrCol).toBeGreaterThanOrEqual(0);

    // Fill MR From = 12
    const mrFrom = table.locator('.wf-filter-row > *').nth(mrCol).locator('input[placeholder="From"]');
    await expect(mrFrom).toBeVisible();
    await mrFrom.click();
    await mrFrom.fill('12');
    await page.waitForTimeout(250);

    const filteredText = await table.locator('.wf-filter-count').innerText();
    const shown = Number(filteredText.match(/Showing (\d+)/)[1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(initialTotal);

    // Verify every visible row has MR >= 12
    const bad = await table.evaluate((t, col) => {
      const rows = Array.from(t.tBodies[0].rows).filter(r => r.style.display !== 'none' && r.querySelector('td'));
      for (const r of rows) {
        const txt = (r.children[col]?.innerText || '').replace(/,/g,'');
        const m = txt.match(/-?\d+(?:\.\d+)?/);
        if (!m || Number(m[0]) < 12) return { txt, val: m ? m[0] : null };
      }
      return null;
    }, mrCol);
    expect(bad).toBeNull();

    // Apply To = 13 as well
    const mrTo = table.locator('.wf-filter-row > *').nth(mrCol).locator('input[placeholder="To"]');
    await mrTo.fill('13');
    await page.waitForTimeout(250);
    const shown2 = Number((await table.locator('.wf-filter-count').innerText()).match(/Showing (\d+)/)[1]);
    expect(shown2).toBeLessThanOrEqual(shown);
    expect(shown2).toBeGreaterThan(0);
    const bad2 = await table.evaluate((t, col) => {
      const rows = Array.from(t.tBodies[0].rows).filter(r => r.style.display !== 'none' && r.querySelector('td'));
      for (const r of rows) {
        const txt = (r.children[col]?.innerText || '').replace(/,/g,'');
        const n = Number((txt.match(/-?\d+(?:\.\d+)?/)||[])[0]);
        if (!(n >= 12 && n <= 13)) return n;
      }
      return null;
    }, mrCol);
    expect(bad2).toBeNull();

    // Clear filters
    await table.locator('.wf-filter-clear').click();
    await page.waitForTimeout(250);
    const clearedText = await table.locator('.wf-filter-count').innerText();
    const clearedShown = Number(clearedText.match(/Showing (\d+)/)[1]);
    expect(clearedShown).toBe(initialTotal);
    await expect(mrFrom).toHaveValue('');
  });

  test('filters a date column (Introduced) by range', async ({ page }) => {
    await loadPageWithFilters(page);
    const table = mainTable(page);
    const introCol = await table.evaluate((t) => {
      const headerRows = Array.from(t.querySelectorAll('thead tr')).filter(r => !r.classList.contains('wf-filter-row') && !r.classList.contains('wf-filter-controls'));
      const headers = Array.from(headerRows[0].children).map(th => th.innerText.replace(/\s+/g,' ').trim());
      return headers.findIndex(h => /^Introduced$/i.test(h));
    });
    expect(introCol).toBeGreaterThanOrEqual(0);

    const from = table.locator('.wf-filter-row > *').nth(introCol).locator('input[placeholder="From"]');
    await expect(from).toHaveAttribute('type', 'date');
    await from.fill('2020-01-01');
    await page.waitForTimeout(250);

    const shown = Number((await table.locator('.wf-filter-count').innerText()).match(/Showing (\d+)/)[1]);
    expect(shown).toBeGreaterThan(0);
    const bad = await table.evaluate((t, col) => {
      const rows = Array.from(t.tBodies[0].rows).filter(r => r.style.display !== 'none' && r.querySelector('td'));
      for (const r of rows) {
        const txt = (r.children[col]?.innerText || '').trim();
        if (txt < '2020-01-01') return txt;
      }
      return null;
    }, introCol);
    expect(bad).toBeNull();
  });
});
