// Custom (computed) columns: formula engine, add/remove UI, placement, filtering,
// sorting and persistence. Deterministic fixtures, no network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, openFixture, inject, parseCount } = require('./helpers');

let browser, context;
before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
});
after(async () => { await browser.close(); });

const row = (...cells) => `<tr>${cells.map(c => (c.startsWith('<t') ? c : `<td>${c}</td>`)).join('')}</tr>`;
const WEAPONS = `<table class="wikitable sortable" id="w"><thead><tr>
  <th>Name</th><th>Damage</th><th>Crit</th><th>Crit Dmg</th><th>Status</th></tr></thead><tbody>
  ${row('Skana', '1,500', '20.00%', '2.00x', '10%')}
  ${row('Galatine', '264', '25.00%', '2.50x', '—')}
  ${row('Lesion', '180.5', '10.00%', '2.00x', '30%')}
  ${row('Skana Prime', '1,800', '30.00%', '2.20x', '20%')}
  ${row('Kronen', '50', '22.00%', '1.50x', '16%')}
</tbody></table>`;

async function fx(html = WEAPONS) {
  const r = await openFixture(context, html);
  return { ...r, w: r.page.locator('#w') };
}

/** Use the UI like a person would: open the form, fill it, press "Add column". */
async function addColumn(t, { name, formula, after: position }) {
  await t.locator('.wf-custom-toggle').click();
  if (name != null) await t.locator('.wf-custom-name').fill(name);
  await t.locator('.wf-custom-formula').fill(formula);
  if (position) await t.locator('.wf-custom-after').selectOption({ label: position });
  await t.locator('.wf-custom-add').click();
}

const headers = (t) => t.evaluate(t => Array.from(t.tHead.rows[0].cells).map(c => c.innerText.trim()));
/** Column values of all data rows (visible or not), by header text of the first header row. */
const column = (t, name) => t.evaluate((t, name) => {
  const i = Array.from(t.tHead.rows[0].cells).findIndex(c => c.innerText.trim() === name);
  return Array.from(t.tBodies[0].rows).filter(r => r.querySelector('td')).map(r => r.cells[i].innerText.trim());
}, name);
const visibleNames = (t) => t.evaluate((t) => Array.from(t.tBodies).flatMap(b => Array.from(b.rows))
  .filter(r => r.querySelector('td') && r.style.display !== 'none').map(r => r.cells[0].innerText.trim()));
const count = async (t) => parseCount(await t.locator('.wf-filter-count').innerText());

/** Visual width (honouring rowspan/colspan) of every row in every section; all must match. */
const rowWidths = (t) => t.evaluate((t) => {
  const widths = [];
  for (const sec of [t.tHead, ...t.tBodies, t.tFoot].filter(Boolean)) {
    const rows = Array.from(sec.rows); const grid = rows.map(() => []);
    rows.forEach((tr, r) => { let c = 0; for (const cell of tr.cells) {
      while (grid[r][c]) c++;
      for (let i = 0; i < cell.rowSpan && r + i < rows.length; i++) for (let j = 0; j < cell.colSpan; j++) grid[r + i][c + j] = 1;
      c += cell.colSpan; } });
    grid.forEach(g => widths.push(g.length));
  }
  return [...new Set(widths)];
});

describe('formula engine', () => {
  it('follows normal math precedence (comparisons bind loosest, unary minus below ^)', async () => {
    const { page, w } = await fx();
    await addColumn(w, { name: 'Math', formula: '2 + 3 * 4 ^ 2 - -1' });
    assert.deepEqual(new Set(await column(w, 'Math')), new Set(['51']));
    await addColumn(w, { name: 'Neg', formula: '-2^2' });
    assert.deepEqual(new Set(await column(w, 'Neg')), new Set(['-4']));
    await addColumn(w, { name: 'Big', formula: 'Damage + 100 > 300' });
    assert.deepEqual(await column(w, 'Big'), ['1', '1', '0', '1', '0'], '(Damage + 100) > 300, not Damage + (100 > 300)');
    await page.close();
  });

  it('understands loose names, [Exact Names], units and functions', async () => {
    const { page, w } = await fx();
    await addColumn(w, { name: 'Avg', formula: 'Damage * (1 + Crit / 100 * ([Crit Dmg] - 1))' });
    assert.deepEqual(await column(w, 'Avg'), ['1800', '363', '198.55', '2448', '55.5']);
    await addColumn(w, { name: 'Loose', formula: 'critdmg + crit_dmg' });
    assert.deepEqual(await column(w, 'Loose'), ['4', '5', '4', '4.4', '3']);
    await addColumn(w, { name: 'Fn', formula: 'if(Crit >= 25, round(sqrt(Damage), 1), max(1, min(5, abs(-3))))' });
    assert.deepEqual(await column(w, 'Fn'), ['3', '16.2', '3', '42.4', '3']);
    await page.close();
  });

  it('leaves the result empty when a referenced cell has no number', async () => {
    const { page, w } = await fx();
    await addColumn(w, { name: 'S2', formula: 'Status * 2' });
    assert.deepEqual(await column(w, 'S2'), ['20', '', '60', '40', '32']);
    await page.close();
  });

  it('can build on an earlier custom column', async () => {
    const { page, w } = await fx();
    await addColumn(w, { name: 'Double', formula: 'Damage * 2' });
    await addColumn(w, { name: 'Quad', formula: 'Double * 2' });
    assert.deepEqual(await column(w, 'Quad'), ['6000', '1056', '722', '7200', '200']);
    await page.close();
  });

  it('rejects bad formulas with a clear message and adds nothing', async () => {
    const { page, w } = await fx();
    const cases = [
      ['Damage * Foo', /unknown column "Foo"/],
      ['Damage *', /ends too early/],
      ['(Damage + 1', /expected "\)"/],
      ['pow(Damage, 2)', /unknown function "pow"/],
      ['1 < 2 < 3', /cannot be chained/],
      ['Damage $ 2', /unexpected character "\$"/],
    ];
    await w.locator('.wf-custom-toggle').click();
    for (const [formula, msg] of cases) {
      await w.locator('.wf-custom-formula').fill(formula);
      await w.locator('.wf-custom-add').click();
      assert.match(await w.locator('.wf-custom-error').innerText(), msg, formula);
    }
    await w.locator('.wf-custom-name').fill('Crit');
    await w.locator('.wf-custom-formula').fill('1');
    await w.locator('.wf-custom-add').click();
    assert.match(await w.locator('.wf-custom-error').innerText(), /already exists/);
    assert.deepEqual(await headers(w), ['Name', 'Damage', 'Crit', 'Crit Dmg', 'Status']);
    await page.close();
  });
});

describe('add / remove UI', () => {
  it('adds a column at the end with header, values, and its own number filter', async () => {
    const { page, w, errors } = await fx();
    await addColumn(w, { name: 'Crit x Dmg', formula: 'Crit * [Crit Dmg]' });
    assert.deepEqual(errors, []);
    assert.deepEqual(await headers(w), ['Name', 'Damage', 'Crit', 'Crit Dmg', 'Status', 'Crit x Dmg']);
    assert.deepEqual(await column(w, 'Crit x Dmg'), ['40', '62.5', '20', '66', '33']);
    assert.equal(await w.locator('.wf-filter-row > th').count(), 6);
    assert.equal(await w.locator('.wf-filter-controls th').getAttribute('colspan'), '6');
    assert.deepEqual(await rowWidths(w), [6]);
    const f = w.locator('.wf-filter-row > th').nth(5);
    assert.equal(await f.locator('.wf-from').getAttribute('aria-label'), 'Filter Crit x Dmg from');
    await f.locator('.wf-from').fill('60');
    assert.deepEqual(await visibleNames(w), ['Galatine', 'Skana Prime']);
    assert.deepEqual(await count(w), { shown: 2, total: 5 });
    await page.close();
  });

  it('places a column after a chosen column, or at the start', async () => {
    const { page, w } = await fx();
    await addColumn(w, { name: 'D2', formula: 'Damage / 2', after: 'after Damage' });
    await addColumn(w, { name: 'First', formula: '1', after: 'at the start' });
    assert.deepEqual(await headers(w), ['First', 'Name', 'Damage', 'D2', 'Crit', 'Crit Dmg', 'Status']);
    assert.deepEqual(await column(w, 'D2'), ['750', '132', '90.25', '900', '25']);
    await page.close();
  });

  it('the × button removes the column and restores the table exactly', async () => {
    const { page, w } = await fx();
    const snapshot = () => w.evaluate(t => Array.from(t.querySelectorAll('tr'))
      .filter(r => !/wf-filter/.test(r.className))
      .map(r => Array.from(r.cells).map(c => `${c.tagName}${c.colSpan}x${c.rowSpan}:${c.innerText.trim()}`).join('|')));
    const original = await snapshot();
    await addColumn(w, { name: 'X', formula: 'Damage + 1', after: 'after Name' });
    assert.notDeepEqual(await snapshot(), original);
    await w.locator('th[data-wf-custom] .wf-custom-remove').click();
    assert.deepEqual(await snapshot(), original);
    assert.equal(await w.locator('.wf-filter-row > th').count(), 5);
    await page.close();
  });

  it('removing a column keeps columns that were placed after it', async () => {
    const { page, w } = await fx();
    await addColumn(w, { name: 'A1', formula: '1', after: 'after Name' });
    await addColumn(w, { name: 'A2', formula: '2', after: 'after A1' });
    assert.deepEqual(await headers(w), ['Name', 'A1', 'A2', 'Damage', 'Crit', 'Crit Dmg', 'Status']);
    await w.locator('th[data-wf-custom]', { hasText: 'A1' }).locator('.wf-custom-remove').click();
    assert.deepEqual(await headers(w), ['Name', 'A2', 'Damage', 'Crit', 'Crit Dmg', 'Status']);
    await page.close();
  });

  it('existing filters stay applied when columns are added or removed', async () => {
    const { page, w } = await fx();
    await w.locator('.wf-filter-row > th').nth(1).locator('.wf-from').fill('200');
    assert.deepEqual(await visibleNames(w), ['Skana', 'Galatine', 'Skana Prime']);
    await addColumn(w, { name: 'Z', formula: 'Damage', after: 'at the start' });
    assert.deepEqual(await visibleNames(w), ['1500', '264', '1800']); // first cell is now Z
    assert.equal(await w.locator('.wf-filter-row > th').nth(2).locator('.wf-from').inputValue(), '200');
    await w.locator('th[data-wf-custom] .wf-custom-remove').click();
    assert.deepEqual(await visibleNames(w), ['Skana', 'Galatine', 'Skana Prime']);
    await page.close();
  });

  it('custom columns (and filters on them) persist across reloads', async () => {
    const { page, w } = await fx();
    await addColumn(w, { name: 'Half', formula: 'Damage / 2', after: 'after Damage' });
    await w.locator('.wf-filter-row > th').nth(2).locator('.wf-to').fill('100');
    await page.reload();
    await inject(page);
    assert.deepEqual(await headers(w), ['Name', 'Damage', 'Half', 'Crit', 'Crit Dmg', 'Status']);
    assert.equal(await w.locator('.wf-filter-row > th').nth(2).locator('.wf-to').inputValue(), '100');
    assert.deepEqual(await visibleNames(w), ['Lesion', 'Kronen']);
    await w.locator('th[data-wf-custom] .wf-custom-remove').click();
    await page.reload();
    await inject(page);
    assert.deepEqual(await headers(w), ['Name', 'Damage', 'Crit', 'Crit Dmg', 'Status']);
    await page.close();
  });

  it('a saved column whose formula no longer fits the table is reported, not fatal', async () => {
    const { page, w, errors } = await fx();
    await page.evaluate(() => localStorage.setItem('wf-custcols:' + location.pathname + ':0',
      JSON.stringify([{ id: 'bad', name: 'Old', formula: 'Removed * 2', after: 'end' },
        { id: 'ok', name: 'Good', formula: 'Damage * 2', after: 'end' }])));
    await page.reload();
    await inject(page);
    assert.deepEqual(errors, []);
    assert.match(await w.locator('.wf-custom-msg').innerText(), /Old: unknown column "Removed"/);
    assert.deepEqual(await headers(w), ['Name', 'Damage', 'Crit', 'Crit Dmg', 'Status', 'Good']);
    await page.close();
  });
});

describe('table shapes and sorting', () => {
  it('grouped headers and caption rows widen correctly around a new column', async () => {
    const html = `<table class="wikitable" id="w"><thead>
      <tr><th colspan="3">Melee stats</th></tr>
      <tr><th rowspan="2">Name</th><th colspan="2">Damage</th></tr>
      <tr><th>Min</th><th>Max</th></tr></thead><tbody>
      ${['A', 'B', 'C', 'D', 'E'].map((n, i) => row(n, String(i + 1), String((i + 1) * 10))).join('')}
      <tr><td colspan="3">footnote row</td></tr></tbody></table>`;
    const { page, w } = await openFixture(context, html).then(r => ({ ...r, w: r.page.locator('#w') }));
    await addColumn(w, { name: 'Spread', formula: '[Damage Max] - [Damage Min]', after: 'after Damage Min' });
    assert.deepEqual(await rowWidths(w), [4]);
    const values = await w.evaluate(t => Array.from(t.tBodies[0].rows).filter(r => r.cells.length > 1).map(r => r.cells[2].innerText));
    assert.deepEqual(values, ['9', '18', '27', '36', '45']);
    assert.equal(await w.locator('thead th', { hasText: 'Damage' }).first().getAttribute('colspan'), '3');
    await w.locator('th[data-wf-custom] .wf-custom-remove').click();
    assert.deepEqual(await rowWidths(w), [3]);
    assert.equal(await w.locator('thead th', { hasText: 'Damage' }).first().getAttribute('colspan'), '2');
    await page.close();
  });

  it('rowspan cells in the body do not shift computed values', async () => {
    const html = `<table class="wikitable" id="w"><thead><tr><th>Group</th><th>Name</th><th>Val</th></tr></thead><tbody>
      ${row('<td rowspan="3">G1</td>', 'A', '1')}${row('B', '2')}${row('C', '3')}
      ${row('<td rowspan="2">G2</td>', 'D', '4')}${row('E', '5')}</tbody></table>`;
    const { page, w } = await openFixture(context, html).then(r => ({ ...r, w: r.page.locator('#w') }));
    await addColumn(w, { name: 'V10', formula: 'Val * 10' });
    assert.deepEqual(await column(w, 'V10'), ['10', '20', '30', '40', '50']);
    assert.deepEqual(await rowWidths(w), [4]);
    await page.close();
  });

  it('sorting works on custom columns and on original columns after a middle insert', async () => {
    const { page, w } = await fx();
    await addColumn(w, { name: 'Neg', formula: '0 - Damage', after: 'after Name' });
    const negHeader = w.locator('thead tr').first().locator('th[data-wf-custom]');
    await negHeader.click();
    assert.deepEqual(await column(w, 'Name'), ['Skana Prime', 'Skana', 'Galatine', 'Lesion', 'Kronen']);
    assert.equal(await negHeader.getAttribute('aria-sort'), 'ascending');
    await negHeader.click();
    assert.deepEqual(await column(w, 'Name'), ['Kronen', 'Lesion', 'Galatine', 'Skana', 'Skana Prime']);
    // "Crit" is now the 4th cell; sorting must use it, not the old 3rd position.
    await w.locator('thead tr').first().locator('th', { hasText: /^Crit$/ }).click();
    assert.deepEqual(await column(w, 'Crit'), ['10.00%', '20.00%', '22.00%', '25.00%', '30.00%']);
    // filter row and controls stay put
    assert.deepEqual(await w.evaluate(t => Array.from(t.tHead.rows).map(r => r.className.split(' ')[0])),
      ['', 'wf-filter-controls', 'wf-filter-row']);
    await page.close();
  });

  it('clicking inside the add-column form never sorts the table', async () => {
    const { page, w } = await fx();
    const before = await column(w, 'Name');
    await w.locator('.wf-custom-toggle').click();
    await w.locator('.wf-custom-formula').click();
    await w.locator('.wf-custom-after').click();
    await w.locator('.wf-custom-cancel').click();
    assert.deepEqual(await column(w, 'Name'), before);
    assert.equal(await w.locator('.wf-custom-form').isVisible(), false);
    await page.close();
  });
});
