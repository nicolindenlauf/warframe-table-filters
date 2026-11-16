// Live tests against real Warframe Wiki pages with different table layouts.
// Run: node --test tests/   (needs network access to wiki.warframe.com)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, openWikiPage, parseCount, DATA_ROWS_JS, visibleColumnValues, firstNumber } = require('./helpers');

// A spread of layouts: huge comparison tables, tabbers with many hidden tables, header-in-tbody
// tables, date columns, grouped headers, rowspans and small infobox-style tables.
const PAGES = [
  'Weapon_Comparison/Melee',
  'Weapon_Comparison/Primary',
  'Weapon_Comparison/Secondary',
  'Warframes_Comparison',
  'Prime_Vault',
  'Ducats',
  'Arcane_Enhancements',
  'Mastery_Rank',
  'Riven_Mods',
  'Helminth',
  'Syndicates',
  'Damage',
];

let browser, context;
before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
});
after(async () => { await browser.close(); });

/** Structural report for each candidate table on the page. */
function tableReport(page) {
  return page.evaluate((dataRowsSrc) => {
    const dataRows = eval(dataRowsSrc); // eslint-disable-line no-eval
    return Array.from(document.querySelectorAll('table.wikitable, table.sortable')).map((t, idx) => {
      const rows = dataRows(t);
      // visual column count of a row = sum of colspans
      const width = (r) => Array.from(r.cells).reduce((n, c) => n + (c.colSpan || 1), 0);
      const fr = t.querySelector('.wf-filter-row');
      const ctl = t.querySelector('.wf-filter-controls th');
      return {
        idx,
        marked: !!t.getAttribute('data-wf-filters-ready'),
        hasUI: !!fr,
        dataRows: rows.length,
        columns: rows.length ? Math.max(...rows.map(width)) : 0,
        filterCells: fr ? fr.children.length : 0,
        controlsSpan: ctl ? ctl.colSpan : 0,
        count: t.querySelector('.wf-filter-count') ? t.querySelector('.wf-filter-count').textContent : null,
        visible: t.offsetParent !== null,
      };
    });
  }, DATA_ROWS_JS);
}

/** Pick the largest enhanced table a user can actually see (not in a collapsed section or hidden tab). */
async function mainTable(page) {
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('table.wikitable, table.sortable'))
    .map((t, i) => ({ i, rows: t.querySelector('.wf-filter-row') ? t.querySelectorAll('tbody tr').length : -1 }))
    .filter(x => x.rows > 0).sort((a, b) => b.rows - a.rows).map(x => x.i));
  for (const i of order) {
    const loc = page.locator('table.wikitable, table.sortable').nth(i);
    if (await loc.locator('.wf-filter-clear').isVisible()) return loc;
  }
  return null;
}

async function filterTypes(table) {
  return table.evaluate(t => Array.from(t.querySelector('.wf-filter-row').children).map(th => {
    const i = th.querySelector('input'); return i ? (i.classList.contains('wf-text') ? 'text' : i.type) : null;
  }));
}

for (const slug of PAGES) {
  describe(`live: ${slug}`, () => {
    let page, scriptErrors;
    before(async () => { ({ page, scriptErrors } = await openWikiPage(context, slug)); });
    after(async () => { if (page) await page.close(); });

    it('injects without JavaScript errors', () => {
      assert.deepEqual(scriptErrors(), []);
    });

    it('every table it claims has a filter UI, and the large ones are covered', async () => {
      const report = await tableReport(page);
      const markedWithoutUI = report.filter(r => r.marked && !r.hasUI);
      assert.deepEqual(markedWithoutUI, [], 'tables marked as enhanced but with no filter row');
      const bigUncovered = report.filter(r => r.dataRows >= 20 && !r.hasUI);
      assert.deepEqual(bigUncovered, [], 'tables with 20+ rows left without filters');
    });

    it('filter row and controls bar line up with the data columns', async () => {
      const bad = (await tableReport(page)).filter(r => r.hasUI &&
        (r.filterCells !== r.columns || r.controlsSpan !== r.columns));
      assert.deepEqual(bad, []);
    });

    it('initial count shows every data row', async () => {
      const bad = (await tableReport(page)).filter(r => r.hasUI)
        .filter(r => { const c = parseCount(r.count); return !c || c.shown !== r.dataRows || c.total !== r.dataRows; });
      assert.deepEqual(bad, []);
    });

    it('numeric, text and date filters narrow the main table correctly; clear restores', async () => {
      const table = await mainTable(page);
      if (!table) return; // page with nothing to filter: covered by the checks above
      const countLoc = table.locator('.wf-filter-count');
      const initial = parseCount(await countLoc.innerText());
      const types = await filterTypes(table);
      const cell = (i) => table.locator('.wf-filter-row > th').nth(i);

      // Numeric: From = median value => every visible row >= median, fewer rows than before.
      for (let i = 0; i < types.length; i++) {
        if (types[i] !== 'number') continue;
        const nums = (await visibleColumnValues(table, i)).map(firstNumber).filter(n => n != null).sort((a, b) => a - b);
        if (new Set(nums).size < 2) continue;
        const median = nums[Math.floor(nums.length / 2)];
        if (median === nums[0]) continue; // need a threshold that actually removes rows
        await cell(i).locator('.wf-from').fill(String(median));
        const after = parseCount(await countLoc.innerText());
        assert.ok(after.shown > 0 && after.shown < initial.total, `column ${i} From=${median}: ${JSON.stringify(after)}`);
        const vis = (await visibleColumnValues(table, i)).map(firstNumber);
        assert.ok(vis.every(n => n != null && n >= median), `column ${i}: visible value below ${median}: ${vis.find(n => !(n >= median))}`);
        // Right-click clears just this column.
        await cell(i).locator('.wf-from').click({ button: 'right' });
        assert.deepEqual(parseCount(await countLoc.innerText()), initial);
        break;
      }

      // Text: type part of a real value => every visible row contains it.
      const ti = types.indexOf('text');
      if (ti >= 0) {
        const sample = (await visibleColumnValues(table, ti)).map(v => (v || '').match(/[A-Za-z]{3,}/)).find(Boolean);
        if (sample) {
          const needle = sample[0].slice(0, 4).toLowerCase();
          await cell(ti).locator('input').fill(needle);
          const vis = await visibleColumnValues(table, ti);
          assert.ok(vis.length > 0, `text "${needle}" matched nothing`);
          assert.ok(vis.every(v => (v || '').toLowerCase().includes(needle)), `text "${needle}" left a non-matching row`);
          await table.locator('.wf-filter-clear').click();
        }
      }

      // Date: From = median date.
      const di = types.indexOf('date');
      if (di >= 0) {
        const dates = (await visibleColumnValues(table, di)).map(v => (v || '').match(/\d{4}-\d{2}-\d{2}/)).filter(Boolean).map(m => m[0]).sort();
        const mid = dates[Math.floor(dates.length / 2)];
        if (mid && mid !== dates[0]) {
          await cell(di).locator('.wf-from').fill(mid);
          const vis = await visibleColumnValues(table, di);
          assert.ok(vis.length > 0);
          assert.ok(vis.every(v => ((v || '').match(/\d{4}-\d{2}-\d{2}/) || [''])[0] >= mid), `date before ${mid} still visible`);
        }
      }

      await table.locator('.wf-filter-clear').click();
      assert.deepEqual(parseCount(await countLoc.innerText()), initial);
    });
  });
}

describe('live: interaction with the wiki on Weapon_Comparison/Melee', () => {
  let page, table;
  before(async () => {
    ({ page } = await openWikiPage(context, 'Weapon_Comparison/Melee'));
    table = await mainTable(page);
  });
  after(async () => { if (page) await page.close(); });

  it('sorting by a header still works and keeps the active filter', async () => {
    const typeIdx = await table.evaluate(t => Array.from(t.tHead.rows[0].cells).findIndex(c => c.innerText.trim() === 'Type'));
    const critIdx = await table.evaluate(t => Array.from(t.tHead.rows[0].cells).findIndex(c => c.innerText.trim() === 'Crit'));
    await table.locator('.wf-filter-row > th').nth(critIdx).locator('.wf-from').fill('30');
    const shown = parseCount(await table.locator('.wf-filter-count').innerText()).shown;
    const typeHeader = table.locator('thead tr').first().locator('th').nth(typeIdx);
    await typeHeader.click();
    await typeHeader.click();
    const types = await visibleColumnValues(table, typeIdx);
    assert.deepEqual(types, [...types].sort((a, b) => b.localeCompare(a)), 'rows are not sorted descending by Type');
    assert.equal(parseCount(await table.locator('.wf-filter-count').innerText()).shown, shown);
    assert.ok((await visibleColumnValues(table, critIdx)).every(v => firstNumber(v) >= 30));
    // the injected rows stay in the header, below the real header row
    assert.deepEqual(await table.evaluate(t => Array.from(t.tHead.rows).map(r => r.className.split(' ')[0])),
      ['', 'wf-filter-controls', 'wf-filter-row']);
    await table.locator('.wf-filter-clear').click();
  });

  it('typing in or clicking the filter rows does not sort the table', async () => {
    const first = () => table.evaluate(t => t.tBodies[0].rows[0].innerText);
    const before = await first();
    await table.locator('.wf-filter-row > th').first().click({ position: { x: 2, y: 2 } });
    await table.locator('.wf-filter-controls th').click({ position: { x: 500, y: 4 } });
    assert.equal(await first(), before);
  });

  it('sticky header: column titles stay readable when scrolled (no overlap with filter rows)', async () => {
    await table.evaluate(t => window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY + 3000));
    await page.waitForTimeout(200);
    const boxes = await table.evaluate(t => Array.from(t.tHead.rows).map(r => {
      const b = r.cells[0].getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) };
    }));
    for (let i = 1; i < boxes.length; i++) {
      assert.ok(boxes[i].top >= boxes[i - 1].bottom - 1, `thead row ${i} overlaps row ${i - 1}: ${JSON.stringify(boxes)}`);
    }
  });

  it('custom column: computed from real cells, filterable, sorts correctly next to tablesorter, removable', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const headerTexts = () => table.evaluate(t => Array.from(t.tHead.rows[0].cells).map(c => c.innerText.replace(/\s+/g, ' ').trim()));
    const idx = async (name) => (await headerTexts()).indexOf(name);
    const cellsOf = (i) => table.evaluate((t, i) => Array.from(t.tBodies[0].rows)
      .filter(r => r.style.display !== 'none').map(r => r.cells[i].innerText.trim()), i);

    await table.locator('.wf-custom-toggle').click();
    await table.locator('.wf-custom-name').fill('Eff Crit');
    await table.locator('.wf-custom-formula').fill('Crit * [Crit Dmg]');
    await table.locator('.wf-custom-after').selectOption({ label: 'after Crit' });
    await table.locator('.wf-custom-add').click();

    const crit = await idx('Crit');
    const eff = await idx('Eff Crit');
    assert.equal(eff, crit + 1, 'placed right after Crit');
    const [c, cd, e] = await Promise.all([cellsOf(crit), cellsOf(await idx('Crit Dmg')), cellsOf(eff)]);
    for (let k = 0; k < 50; k++) {
      const expected = Math.round(firstNumber(c[k]) * firstNumber(cd[k]) * 10000) / 10000;
      assert.equal(Number(e[k]), expected, `row ${k}: ${c[k]} * ${cd[k]}`);
    }

    // filter on it
    const fcell = table.locator('.wf-filter-row > th').nth(eff);
    await fcell.locator('.wf-from').fill('100');
    assert.ok((await cellsOf(eff)).every(v => Number(v) >= 100));
    await fcell.locator('.wf-from').fill('');

    // sorting by the custom column uses the wiki's sort-arrow styling (one arrow, not tiled)
    const effHeader = table.locator('thead tr').first().locator('th[data-wf-custom]');
    await effHeader.click();
    const effVals = (await cellsOf(eff)).map(Number);
    assert.deepEqual(effVals, [...effVals].sort((a, b) => a - b));
    const look = await effHeader.evaluate(th => ({ cls: th.className, repeat: getComputedStyle(th).backgroundRepeat }));
    assert.match(look.cls, /\bheaderSort\b/);
    assert.match(look.cls, /\bheaderSortUp\b/);
    assert.equal(look.repeat, 'no-repeat', 'sort arrow must not tile across the header');

    // sorting an original column after the insert sorts *that* column
    const typeIdx = await idx('Type');
    const typeHeader = table.locator('thead tr').first().locator('th').nth(typeIdx);
    await typeHeader.click();
    const types = await cellsOf(typeIdx);
    assert.deepEqual(types, [...types].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    const statusIdx = await idx('Status');
    const statusHeader = table.locator('thead tr').first().locator('th').nth(statusIdx);
    const box = await statusHeader.boundingBox(); // the title is a link: click the sort-arrow area
    await statusHeader.click({ position: { x: box.width - 6, y: box.height / 2 } });
    const status = (await cellsOf(statusIdx)).map(firstNumber);
    assert.deepEqual(status, [...status].sort((a, b) => a - b));

    // remove it again; tablesorter takes over normally
    await table.locator('th[data-wf-custom] .wf-custom-remove').click();
    assert.equal(await idx('Eff Crit'), -1);
    // tablesorter cycles asc -> desc -> original order (its state carries over), so within
    // three clicks the column must come out sorted.
    let sorted = false;
    for (let k = 0; k < 3 && !sorted; k++) {
      await typeHeader.click();
      const types2 = await cellsOf(await idx('Type'));
      const asc = JSON.stringify([...types2].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
      const desc = JSON.stringify([...types2].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })));
      sorted = JSON.stringify(types2) === asc || JSON.stringify(types2) === desc;
    }
    assert.ok(sorted, 'tablesorter sorts again after removal');
  });
});
