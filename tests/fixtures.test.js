// Deterministic tests against hand-built tables (no network).
// Each test encodes how the filters are *supposed* to behave for a user.
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
const table = (id, headers, rows, extra = '') =>
  `<table class="wikitable sortable" id="${id}" ${extra}><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
   <tbody>${rows.join('')}</tbody></table>`;
/** n simple rows: [name, value] with names a..  and values 1.. */
const simpleRows = (n) => Array.from({ length: n }, (_, i) => row(String.fromCharCode(97 + i), String(i + 1)));

const WEAPONS = table('w', ['Name', 'Type', 'Damage', 'Range', 'Crit', 'Speed', 'Introduced', 'Notes'], [
  row('Skana', 'Sword', '1,500', '2.50 m', '20.00%', '1.080x animation speed', '2012-10-25', ''),
  row('Galatine', 'Heavy Blade', '264', '3.00 m', '25.00%', '0.917x animation speed', '2013-11-20', ''),
  row('Lesion', 'Polearm', '180.5', '2.80 m', '10.00%', '1.000x animation speed', '2017-03-17', 'x'),
  row('Skana Prime', 'Sword', '1,800', '2.50 m', '30.00%', '1.083x animation speed', '2018-07-03', ''),
  row('Kronen', 'Tonfa', '-12', '2.20 m', '22.00%', '1.000x animation speed', '2016-04-01 12:30', ''),
]);

async function fx(html, opts) {
  const r = await openFixture(context, html, opts);
  return { ...r, t: (id) => r.page.locator('#' + id) };
}
const filterCell = (t, i) => t.locator('.wf-filter-row > th').nth(i);
const visibleNames = (t) => t.evaluate((t) => Array.from(t.tBodies).flatMap(b => Array.from(b.rows))
  .filter(r => r.querySelector('td') && r.style.display !== 'none').map(r => r.cells[0].innerText.trim()));
const count = async (t) => parseCount(await t.locator('.wf-filter-count').innerText());
const inputKinds = (t) => t.evaluate(t => Array.from(t.querySelector('.wf-filter-row').children).map(th => {
  const ins = Array.from(th.querySelectorAll('input'));
  return ins.length ? ins.map(i => (i.classList.contains('wf-text') ? 'text' : i.type)).join('+') : null;
}));

describe('UI injection', () => {
  it('adds a controls bar and one filter cell per column, typed by content', async () => {
    const { page, errors, t } = await fx(WEAPONS);
    const w = t('w');
    assert.deepEqual(errors, []);
    // Name/Type text, Damage/Range/Crit/Speed number, Introduced date, Notes too sparse -> no filter
    assert.deepEqual(await inputKinds(w),
      ['text', 'text', 'number+number', 'number+number', 'number+number', 'number+number', 'date+date', null]);
    assert.equal(await w.locator('.wf-filter-controls th').getAttribute('colspan'), '8');
    assert.deepEqual(await count(w), { shown: 5, total: 5 });
    // header row must stay the first thead row (wiki sort icons depend on it)
    assert.equal(await w.evaluate(t => t.tHead.rows[0].className), '');
    await page.close();
  });

  it('is idempotent when the script runs twice', async () => {
    const { page, t } = await fx(WEAPONS);
    await inject(page);
    assert.equal(await t('w').locator('.wf-filter-row').count(), 1);
    assert.equal(await t('w').locator('.wf-filter-controls').count(), 1);
    await page.close();
  });

  it('skips tables with fewer than 5 rows, enhances tables with 5', async () => {
    const { page, t } = await fx(table('s', ['A', 'B'], simpleRows(4)) + table('ok', ['A', 'B'], simpleRows(5)));
    assert.equal(await t('s').locator('.wf-filter-row').count(), 0);
    assert.equal(await t('ok').locator('.wf-filter-row').count(), 1);
    await page.close();
  });

  it('enhances a table inserted shortly after load (dynamic content)', async () => {
    const { page } = await fx('<div id="host"></div>');
    await page.evaluate((h) => { document.getElementById('host').innerHTML = h; },
      table('late', ['N', 'V'], simpleRows(5)));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#late .wf-filter-row').count(), 1);
    await page.close();
  });

  it('still enhances tables that appear long after load (e.g. opened collapsibles)', async () => {
    const { page } = await fx('<div id="host"></div>');
    await page.waitForTimeout(16000);
    await page.evaluate((h) => { document.getElementById('host').innerHTML = h; },
      table('later', ['N', 'V'], simpleRows(5)));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#later .wf-filter-row').count(), 1);
    await page.close();
  });

  it('waits for MediaWiki tablesorter before touching a sortable table', async () => {
    const { page } = await fx('<div id="host"></div>');
    await page.evaluate(() => { window.mw = { loader: {} }; });
    await page.evaluate((h) => { document.getElementById('host').innerHTML = h; },
      table('srt', ['N', 'V'], simpleRows(5)));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#srt .wf-filter-row').count(), 0, 'must not add rows before tablesorter ran');
    await page.evaluate(() => document.getElementById('srt').classList.add('jquery-tablesorter'));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#srt .wf-filter-row').count(), 1);
    await page.close();
  });
});

describe('Filtering', () => {
  it('numeric From/To is inclusive and understands units, commas, %, negatives', async () => {
    const { page, t } = await fx(WEAPONS);
    const w = t('w');
    await filterCell(w, 2).locator('.wf-from').fill('264');
    await filterCell(w, 2).locator('.wf-to').fill('1500');
    assert.deepEqual(await visibleNames(w), ['Skana', 'Galatine']);
    await filterCell(w, 2).locator('.wf-from').fill('-20');
    await filterCell(w, 2).locator('.wf-to').fill('0');
    assert.deepEqual(await visibleNames(w), ['Kronen']);
    await w.locator('.wf-filter-clear').click();
    await filterCell(w, 3).locator('.wf-from').fill('2.5');
    await filterCell(w, 3).locator('.wf-to').fill('2.5');
    assert.deepEqual(await visibleNames(w), ['Skana', 'Skana Prime']);
    await filterCell(w, 4).locator('.wf-from').fill('25');
    assert.deepEqual(await visibleNames(w), ['Skana Prime']);
    assert.deepEqual(await count(w), { shown: 1, total: 5 });
    await page.close();
  });

  it('From greater than To is treated as the same range reversed', async () => {
    const { page, t } = await fx(WEAPONS);
    const w = t('w');
    await filterCell(w, 2).locator('.wf-from').fill('1500');
    await filterCell(w, 2).locator('.wf-to').fill('264');
    assert.deepEqual(await visibleNames(w), ['Skana', 'Galatine']);
    await page.close();
  });

  it('text filter is a case-insensitive "contains"', async () => {
    const { page, t } = await fx(WEAPONS);
    const w = t('w');
    await filterCell(w, 0).locator('input').fill('SKANA');
    assert.deepEqual(await visibleNames(w), ['Skana', 'Skana Prime']);
    await filterCell(w, 1).locator('input').fill('sword');
    assert.deepEqual(await visibleNames(w), ['Skana', 'Skana Prime']);
    await page.close();
  });

  it('date range is inclusive on both ends, including cells with a time', async () => {
    const { page, t } = await fx(WEAPONS);
    const w = t('w');
    await filterCell(w, 6).locator('.wf-from').fill('2016-04-01');
    await filterCell(w, 6).locator('.wf-to').fill('2016-04-01');
    assert.deepEqual(await visibleNames(w), ['Kronen'], 'a 12:30 timestamp on the "To" day must be included');
    await page.close();
  });

  it('right-click clears only that column and suppresses the browser menu', async () => {
    const { page, t } = await fx(WEAPONS);
    const w = t('w');
    await filterCell(w, 0).locator('input').fill('skana');
    await filterCell(w, 4).locator('.wf-from').fill('25');
    assert.deepEqual(await visibleNames(w), ['Skana Prime']);
    const prevented = await filterCell(w, 4).locator('.wf-to').evaluate(el => {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev); return ev.defaultPrevented;
    });
    assert.equal(prevented, true);
    assert.equal(await filterCell(w, 4).locator('.wf-from').inputValue(), '');
    assert.equal(await filterCell(w, 0).locator('input').inputValue(), 'skana');
    assert.deepEqual(await visibleNames(w), ['Skana', 'Skana Prime']);
    await page.close();
  });

  it('right-click on an empty field keeps the normal context menu (e.g. to paste)', async () => {
    const { page, t } = await fx(WEAPONS);
    const prevented = await filterCell(t('w'), 0).locator('input').evaluate(el => {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev); return ev.defaultPrevented;
    });
    assert.equal(prevented, false);
    await page.close();
  });

  it('Escape clears the focused column', async () => {
    const { page, t } = await fx(WEAPONS);
    const w = t('w');
    const from = filterCell(w, 2).locator('.wf-from');
    await from.fill('1000');
    await filterCell(w, 2).locator('.wf-to').fill('2000');
    assert.deepEqual(await count(w), { shown: 2, total: 5 });
    await from.press('Escape');
    assert.equal(await from.inputValue(), '');
    assert.equal(await filterCell(w, 2).locator('.wf-to').inputValue(), '');
    assert.deepEqual(await count(w), { shown: 5, total: 5 });
    await page.close();
  });

  it('scrolling the mouse wheel over a focused number field does not change it', async () => {
    const { page, t } = await fx(WEAPONS);
    const from = filterCell(t('w'), 2).locator('.wf-from');
    await from.fill('30');
    await from.focus();
    const box = await from.boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(150);
    assert.equal(await from.inputValue(), '30');
    await page.close();
  });

  it('badge shows how many filters are active, and is hidden when none are', async () => {
    const { page, t } = await fx(WEAPONS);
    const w = t('w');
    const badge = w.locator('.wf-filter-badge');
    assert.equal(await badge.isVisible(), false);
    await filterCell(w, 0).locator('input').fill('s');
    assert.equal(await badge.innerText(), '1');
    await filterCell(w, 2).locator('.wf-from').fill('1');
    assert.equal(await badge.innerText(), '2');
    await w.locator('.wf-filter-clear').click();
    assert.equal(await badge.isVisible(), false);
    await page.close();
  });

  it('"Clear filters" resets every input and shows all rows', async () => {
    const { page, t } = await fx(WEAPONS);
    const w = t('w');
    await filterCell(w, 0).locator('input').fill('zzz');
    await filterCell(w, 2).locator('.wf-from').fill('1');
    assert.deepEqual(await count(w), { shown: 0, total: 5 });
    await w.locator('.wf-filter-clear').click();
    assert.deepEqual(await count(w), { shown: 5, total: 5 });
    const values = await w.locator('.wf-filter-row input').evaluateAll(els => els.map(e => e.value));
    assert.ok(values.every(v => v === ''));
    await page.close();
  });

  it('only filters its own table', async () => {
    const { page, t } = await fx(WEAPONS + table('o', ['Name', 'V'], simpleRows(5)));
    await filterCell(t('w'), 0).locator('input').fill('nothing-matches');
    assert.deepEqual(await count(t('o')), { shown: 5, total: 5 });
    await page.close();
  });

  it('filters survive a page reload (same tab)', async () => {
    const { page, t } = await fx(WEAPONS);
    await filterCell(t('w'), 0).locator('input').fill('skana');
    await page.reload();
    await inject(page);
    assert.equal(await filterCell(t('w'), 0).locator('input').inputValue(), 'skana');
    assert.deepEqual(await visibleNames(t('w')), ['Skana', 'Skana Prime']);
    await t('w').locator('.wf-filter-clear').click();
    await page.reload();
    await inject(page);
    assert.deepEqual(await count(t('w')), { shown: 5, total: 5 });
    await page.close();
  });
});

describe('Wiki table shapes (edge cases)', () => {
  it('grouped (multi-row) headers do not crash, and later tables still get filters', async () => {
    const grouped = `<table class="wikitable" id="g"><thead>
      <tr><th rowspan="2">Name</th><th colspan="2">Damage</th></tr>
      <tr><th>Min</th><th>Max</th></tr></thead><tbody>
      ${row('A', '1', '10')}${row('B', '2', '20')}${row('C', '3', '30')}${row('D', '4', '40')}${row('E', '5', '50')}</tbody></table>`;
    const { page, errors, t } = await fx(grouped + table('after', ['N', 'V'], simpleRows(5)));
    assert.deepEqual(errors, [], 'script threw on a grouped header');
    assert.equal(await t('after').locator('.wf-filter-row').count(), 1, 'one bad table must not stop the rest');
    assert.equal(await t('g').locator('.wf-filter-row > th').count(), 3);
    assert.equal(await filterCell(t('g'), 2).locator('.wf-from').getAttribute('aria-label'), 'Filter Damage Max from');
    await filterCell(t('g'), 2).locator('.wf-from').fill('20');
    await filterCell(t('g'), 2).locator('.wf-to').fill('30');
    assert.deepEqual(await visibleNames(t('g')), ['B', 'C']);
    await page.close();
  });

  it('a full-width caption row above the headers does not prevent filters', async () => {
    const html = `<table class="wikitable" id="cap"><tbody>
      <tr><th colspan="2">Normal Attributes</th></tr><tr><th>Stat</th><th>Value</th></tr>
      ${simpleRows(5).join('')}</tbody></table>`;
    const { page, t } = await fx(html);
    assert.equal(await t('cap').locator('.wf-filter-row > th').count(), 2);
    assert.equal(await filterCell(t('cap'), 1).locator('.wf-from').getAttribute('aria-label'), 'Filter Value from');
    assert.deepEqual(await count(t('cap')), { shown: 5, total: 5 });
    await page.close();
  });

  it('a table whose header lives in <tbody> reports the right row total', async () => {
    const html = `<table class="wikitable" id="nt"><tbody><tr><th>Name</th><th>Val</th></tr>
      ${simpleRows(5).join('')}</tbody></table>`;
    const { page, t } = await fx(html);
    assert.deepEqual(await count(t('nt')), { shown: 5, total: 5 });
    await page.close();
  });

  it('rowspan in the body keeps filters aligned with the visual columns', async () => {
    const html = table('rs', ['Group', 'Name', 'Val'], [
      row('<td rowspan="3">G1</td>', 'A', '1'), row('B', '2'), row('C', '3'),
      row('<td rowspan="2">G2</td>', 'D', '4'), row('E', '5'),
    ]);
    const { page, t } = await fx(html);
    const rs = t('rs');
    assert.equal(await filterCell(rs, 2).locator('input').count(), 2, 'Val should get a number range');
    await filterCell(rs, 1).locator('input').fill('B');
    const visible = () => rs.evaluate(t => Array.from(t.tBodies[0].rows).filter(r => r.style.display !== 'none').map(r => r.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(await visible(), ['G1 B 2'], 'row B shown with its group cell');
    await filterCell(rs, 1).locator('input').fill('');
    await filterCell(rs, 0).locator('input').fill('g2');
    assert.deepEqual(await visible(), ['G2 D 4', 'G2 E 5']);
    await page.close();
  });

  it('rows in every <tbody> are filtered and counted', async () => {
    const html = `<table class="wikitable" id="tb"><thead><tr><th>Name</th><th>Val</th></tr></thead>
      <tbody>${row('A', '1')}${row('B', '2')}${row('C', '3')}</tbody><tbody>${row('D', '4')}${row('E', '5')}</tbody></table>`;
    const { page, t } = await fx(html);
    assert.deepEqual(await count(t('tb')), { shown: 5, total: 5 });
    await filterCell(t('tb'), 1).locator('.wf-to').fill('2');
    assert.deepEqual(await visibleNames(t('tb')), ['A', 'B']);
    await page.close();
  });

  it('section rows inside the body hide when nothing in their section matches', async () => {
    const html = table('sec', ['Name', 'Val'], [
      '<tr><th colspan="2">Rifles</th></tr>', row('Braton', '1'), row('Boltor', '2'), row('Soma', '3'),
      '<tr><th colspan="2">Pistols</th></tr>', row('Lato', '4'), row('Lex', '5'),
    ]);
    const { page, t } = await fx(html);
    assert.deepEqual(await count(t('sec')), { shown: 5, total: 5 });
    await filterCell(t('sec'), 0).locator('input').fill('lex');
    const shownRows = await t('sec').evaluate(t => Array.from(t.tBodies[0].rows).filter(r => r.style.display !== 'none').map(r => r.cells[0].innerText.trim()));
    assert.deepEqual(shownRows, ['Pistols', 'Lex'], 'only the matching section header stays');
    await page.close();
  });

  it('typographic minus (U+2212) is read as negative', async () => {
    const html = table('m', ['Name', 'Bonus'], [row('A', '−50%'), row('B', '+20%'), row('C', '-10%'), row('D', '5%'), row('E', '−5%')]);
    const { page, t } = await fx(html);
    await filterCell(t('m'), 1).locator('.wf-to').fill('-20');
    assert.deepEqual(await visibleNames(t('m')), ['A']);
    await page.close();
  });

  it('placeholder cells (—, -, N/A) do not turn a numeric column into text', async () => {
    const html = table('p', ['Name', 'Val'], [
      row('A', '1'), row('B', '—'), row('C', '3'), row('D', 'N/A'), row('E', '5'), row('F', '-'), row('G', '7'),
    ]);
    const { page, t } = await fx(html);
    assert.equal(await filterCell(t('p'), 1).locator('input').first().getAttribute('type'), 'number');
    await page.close();
  });

  it('numbers with varying words ("46.30% Electricity") get a range and a text box', async () => {
    const html = table('mx', ['Name', 'Main Element', 'Speed'], [
      row('A', '46.30% Electricity', '1.000x animation speed'), row('B', '100.00% Impact', '1.000x animation speed'),
      row('C', '70.00% Impact', '0.917x animation speed'), row('D', '42.11% Corrosive', '1.080x animation speed'),
      row('E', '100.00% Blast', '1.000x animation speed'),
    ]);
    const { page, t } = await fx(html);
    assert.deepEqual(await inputKinds(t('mx')), ['text', 'number+number+text', 'number+number']);
    await filterCell(t('mx'), 1).locator('.wf-text').fill('impact');
    assert.deepEqual(await visibleNames(t('mx')), ['B', 'C']);
    await filterCell(t('mx'), 1).locator('.wf-from').fill('80');
    assert.deepEqual(await visibleNames(t('mx')), ['B']);
    await page.close();
  });

  it('text filters match the visible text, not hidden data-sort-value keys', async () => {
    const html = table('sv', ['Element', 'N'], [
      row('<td data-sort-value="3">Electricity</td>', '1'),
      row('<td data-sort-value="1">Heat</td>', '2'),
      row('<td data-sort-value="2">Cold</td>', '3'),
      row('<td data-sort-value="Aegis">Arcane Aegis</td>', '4'),
      row('<td data-sort-value="Grenade Fan">Dispensary</td>', '5'),
    ]);
    const { page, t } = await fx(html);
    const input = filterCell(t('sv'), 0).locator('input').first();
    assert.equal(await input.getAttribute('type'), 'text');
    await input.fill('heat');
    assert.deepEqual(await visibleNames(t('sv')), ['Heat']);
    await input.fill('arcane');
    assert.deepEqual(await visibleNames(t('sv')), ['Arcane Aegis']);
    await input.fill('grenade');
    assert.deepEqual(await visibleNames(t('sv')), []);
    await page.close();
  });

  it('header text with quotes produces a complete accessible label', async () => {
    const html = table('q', ['Name', 'Mod "Bonus"'], simpleRows(5));
    const { page, t } = await fx(html);
    const label = await filterCell(t('q'), 1).locator('.wf-from').getAttribute('aria-label');
    assert.equal(label, 'Filter Mod "Bonus" from');
    await page.close();
  });

  it('sticky headers: header, controls and filter rows stack instead of overlapping', async () => {
    const many = Array.from({ length: 80 }, (_, i) => row('n' + i, String(i))).join('');
    const html = `<div style="height:200px"></div><table class="wikitable" id="st"><thead><tr><th>Name</th><th>Val</th></tr></thead><tbody>${many}</tbody></table><div style="height:2000px"></div>`;
    const { page, t } = await fx(html, { head: '<style>table.wikitable thead th{position:sticky;top:0;background:#fff}</style>' });
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(150);
    const boxes = await t('st').evaluate(t => Array.from(t.tHead.rows).map(r => {
      const b = r.cells[0].getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) };
    }));
    assert.equal(boxes[0].top, 0, 'header row should be stuck to the top');
    for (let i = 1; i < boxes.length; i++) {
      assert.ok(boxes[i].top >= boxes[i - 1].bottom - 1, `row ${i} overlaps row ${i - 1}: ${JSON.stringify(boxes)}`);
    }
    await page.close();
  });
});
