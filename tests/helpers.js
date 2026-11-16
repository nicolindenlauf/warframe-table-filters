// Shared helpers for the userscript tests (node:test + Playwright library).
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    path.join(require('os').homedir(), 'playwright-test/node_modules/playwright'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try next */ }
  }
  throw new Error('Playwright not found. Install it or set PLAYWRIGHT_PATH.');
}

const { chromium } = loadPlaywright();

const USERSCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'warframe-wiki-table-filters.user.js'),
  'utf8'
);

const WIKI = 'https://wiki.warframe.com/w/';

async function inject(page) {
  await page.addScriptTag({ content: USERSCRIPT });
  await page.waitForTimeout(300);
}

/** Open a wiki page the way a userscript manager would see it (document-idle), then inject. */
async function openWikiPage(context, slug) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(WIKI + slug, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(1000); // let MediaWiki's tablesorter finish
  const before = errors.length; // errors from the wiki itself are not ours
  await inject(page);
  return { page, scriptErrors: () => errors.slice(before) };
}

let fixtureCounter = 0;
/** Open a page (on a fake http origin, so storage and reloads work) with the given
 *  table HTML, then inject. `head` is extra markup for <head> (e.g. a <style>). */
async function openFixture(context, html, { head = '' } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const doc = `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  const url = `https://fixture.test/page-${++fixtureCounter}`; // own path => own saved state
  await page.route('https://fixture.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: doc }));
  await page.goto(url);
  await inject(page);
  return { page, errors };
}

function parseCount(text) {
  const m = /Showing (\d+) of (\d+) rows/.exec(text || '');
  return m ? { shown: Number(m[1]), total: Number(m[2]) } : null;
}

/** Rows a user would consider data rows (all tbodies, rows containing a <td>). */
const DATA_ROWS_JS = `(t) => Array.from(t.tBodies).flatMap(b => Array.from(b.rows))
  .filter(r => r.querySelector('td') && !r.closest('.wf-filter-row,.wf-filter-controls'))`;

/** Visible values of the column under the given filter-row cell index, for visible data rows.
 *  Uses real geometry (the cell horizontally under the filter cell), so it is correct even
 *  with rowspan/colspan in the body. */
async function visibleColumnValues(table, colIdx) {
  return table.evaluate((t, colIdx) => {
    const fth = t.querySelector('.wf-filter-row').children[colIdx];
    const fr = fth.getBoundingClientRect();
    const cx = fr.left + fr.width / 2;
    const rows = Array.from(t.tBodies).flatMap(b => Array.from(b.rows))
      .filter(r => r.querySelector('td') && r.style.display !== 'none' && r.offsetParent !== null);
    return rows.map(r => {
      const cell = Array.from(r.cells).find(c => {
        const b = c.getBoundingClientRect();
        return b.left <= cx && cx <= b.right;
      });
      return cell ? cell.innerText.replace(/\s+/g, ' ').trim() : null;
    });
  }, colIdx);
}

function firstNumber(s) {
  const m = String(s || '').replace(/,/g, '').replace(/−/g, '-').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

module.exports = {
  chromium, USERSCRIPT, WIKI, inject, openWikiPage, openFixture,
  parseCount, DATA_ROWS_JS, visibleColumnValues, firstNumber,
};
