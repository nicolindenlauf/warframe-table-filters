// ==UserScript==
// @name         Warframe Wiki Table Filters
// @namespace    https://wiki.warframe.com/
// @version      1.1.0
// @description  Adds numeric, date, and text filters to tables on the Warframe Wiki. Press Esc (or right-click a filled field) to clear it.
// @author       nicolindenlauf
// @homepageURL  https://github.com/nicolindenlauf/warframe-table-filters
// @updateURL    https://raw.githubusercontent.com/nicolindenlauf/warframe-table-filters/main/warframe-wiki-table-filters.user.js
// @downloadURL  https://raw.githubusercontent.com/nicolindenlauf/warframe-table-filters/main/warframe-wiki-table-filters.user.js
// @match        https://wiki.warframe.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STYLE_ID = "wf-table-filter-style";
  const MARK = "data-wf-filters-ready";
  const SELECTOR = "table.wikitable, table.sortable, table.jquery-tablesorter";
  const OWN_ROW = /\bwf-filter-(row|controls)\b/;
  const MIN_ROWS = 5; // smaller tables are easy to scan without filters
  const SAMPLE_ROWS = 200; // rows sampled (spread over the table) to detect column types
  const SORTER_WAIT_MS = 8000; // max wait for MediaWiki's tablesorter to initialise a table
  const DAY = 86400000;
  // Cell contents that mean "no value" and must not decide a column's type.
  const PLACEHOLDER = /^(?:[-–—?]|n\/?a|none|tbd|unknown|varies)$/i;
  const states = new WeakMap(); // table -> current filter state
  const sortHooked = new WeakSet();

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Colors are set per-table via --wf-* custom properties (derived from the
         table's own palette in styleTable()), so the filters match light or dark. */
      .wf-filter-row th {
        background: var(--wf-bg, #f7f9fc) !important;
        padding: 3px 2px !important;
        vertical-align: middle !important;
        color: var(--wf-text, #1f2937);
        font-weight: normal;
        border-top: 1px solid var(--wf-border, #c8d1dc) !important;
      }
      .wf-filter-wrap {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 80px;
      }
      .wf-filter-wrap.wf-kind-date { min-width: 118px; }
      .wf-filter-inputs {
        display: flex;
        gap: 3px;
        align-items: center;
      }
      .wf-kind-date .wf-filter-inputs { flex-direction: column; align-items: stretch; }
      .wf-filter-input {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        border: 1px solid var(--wf-border, #b8c4d3);
        border-radius: 4px;
        padding: 3px 4px;
        font: 11px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
        background: var(--wf-input, #fff);
        color: var(--wf-text, #1f2937);
        color-scheme: var(--wf-scheme, light);
      }
      .wf-filter-input[type=number] { -moz-appearance: textfield; appearance: textfield; }
      .wf-filter-input[type=number]::-webkit-inner-spin-button,
      .wf-filter-input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
      .wf-filter-input:focus {
        outline: none;
        border-color: var(--wf-accent, #3b82f6);
        box-shadow: 0 0 0 2px var(--wf-ring, rgba(59,130,246,.2));
      }
      .wf-filter-input.wf-has-value {
        border-color: var(--wf-accent, #3b82f6);
        box-shadow: inset 0 0 0 1px var(--wf-accent, #3b82f6);
      }
      .wf-filter-input::placeholder { color: var(--wf-muted, #8a97a8); }
      .wf-filter-input::-webkit-calendar-picker-indicator { cursor: pointer; }
      .wf-filter-none {
        font: 600 10px/1 system-ui, -apple-system, Segoe UI, sans-serif;
        color: var(--wf-muted, #526172);
        opacity: .45;
      }
      .wf-filter-controls th {
        background: var(--wf-controls, #e8eef5) !important;
        padding: 6px 8px !important;
        text-align: left !important;
        font: 12px/1.3 system-ui, -apple-system, Segoe UI, sans-serif;
        color: var(--wf-text, #334155);
        border-bottom: 1px solid var(--wf-border, #c8d1dc);
      }
      .wf-filter-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .wf-filter-btn {
        border: 1px solid var(--wf-border, #b8c4d3);
        background: var(--wf-input, #fff);
        color: var(--wf-text, #1f2937);
        border-radius: 4px;
        padding: 4px 10px;
        font: 600 11px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
        cursor: pointer;
      }
      .wf-filter-btn:hover { background: var(--wf-hover, #f3f6fa); }
      .wf-filter-count { color: var(--wf-muted, #526172); }
      .wf-filter-hint { color: var(--wf-muted, #526172); font-size: 11px; }
      /* Keep the controls inside the visible area on tables wider than the screen. */
      .wf-controls-inner { position: sticky; left: 8px; max-width: min(100%, 85vw); }
      .wf-custom-form {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        margin-top: 6px;
      }
      .wf-custom-form[hidden], .wf-custom-msg[hidden] { display: none; }
      .wf-custom-form .wf-filter-input { width: auto; font-size: 12px; padding: 4px 6px; }
      .wf-custom-form .wf-custom-name { width: 10em; }
      .wf-custom-form .wf-custom-formula { flex: 1 1 22em; max-width: 40em; }
      .wf-custom-error, .wf-custom-msg { color: var(--wf-error, #b91c1c); font-weight: 600; }
      .wf-custom-msg { margin-top: 4px; font-size: 11px; }
      .wf-custom-error:empty { display: none; }
      .wf-custom-error { flex-basis: 100%; }
      .wf-custom-help { flex-basis: 100%; color: var(--wf-muted, #526172); font-size: 11px; }
      .wf-custom-head { cursor: pointer; white-space: nowrap; }
      .wf-custom-remove {
        margin-left: 4px;
        padding: 0 3px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        opacity: .6;
      }
      .wf-custom-remove::before { content: "×"; }
      .wf-custom-remove:hover { opacity: 1; }
      .wf-filter-badge {
        display: inline-block;
        margin-left: 4px;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--wf-accent, #2563eb);
        color: var(--wf-badge-fg, #fff);
        font-size: 10px;
        font-weight: 700;
        vertical-align: middle;
      }
      .wf-filter-badge[hidden] { display: none; }
    `;
    document.head.appendChild(style);
  }

  // ===================== Cell values =====================

  // Visible text of a cell. Deliberately ignores data-sort-value: the wiki often uses
  // sort keys that differ from what is shown ("Arcane Aegis" sorts as "Aegis"), and
  // users filter by what they see. Cached once the cell is rendered.
  const textCache = new WeakMap();
  function cellText(cell) {
    if (!cell) return "";
    const cached = textCache.get(cell);
    if (cached != null) return cached;
    const text = (cell.innerText || cell.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (cell.getClientRects().length) textCache.set(cell, text); // innerText is only exact when rendered
    return text;
  }

  function isPlaceholder(text) {
    return !text || PLACEHOLDER.test(text);
  }

  function parseDateValue(text) {
    if (!text) return null;
    const m = text.match(
      /\b(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\b/,
    );
    if (m) {
      const t = Date.UTC(
        +m[1],
        +m[2] - 1,
        +m[3],
        +(m[4] || 0),
        +(m[5] || 0),
        +(m[6] || 0),
      );
      return Number.isNaN(t) ? null : t;
    }
    const m2 = text.match(/\b(\d{4})\/(\d{2})\/(\d{2})\b/);
    if (m2) {
      const t = Date.UTC(+m2[1], +m2[2] - 1, +m2[3]);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  }

  function normalizeMinus(text) {
    return text.replace(/[−﹣－]/g, "-"); // typographic minus signs
  }

  function parseNumericValue(text) {
    if (isPlaceholder(text)) return null;
    if (
      /^\s*\d{4}[-/]\d{2}[-/]\d{2}/.test(text) &&
      parseDateValue(text) != null
    )
      return null;
    // first number-like token (handles 1,234.56, -12, −12, 36.00%, 2.50 m, 2.40x, 55°)
    const m = normalizeMinus(text)
      .replace(/,/g, "")
      .match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }

  // Words left in a numeric cell once numbers and symbols are removed ("46.30% Electricity" -> "electricity").
  function residualWords(text) {
    return normalizeMinus(text)
      .replace(/[-+]?\d[\d,]*(?:\.\d+)?/g, " ")
      .replace(/[^a-z]+/gi, " ")
      .trim()
      .toLowerCase();
  }

  // ===================== Table model =====================

  const isOwnRow = (tr) => OWN_ROW.test(tr.className);
  const rowsOf = (section) =>
    Array.from(section.rows).filter((r) => !isOwnRow(r));
  const hasTd = (tr) => Array.from(tr.cells).some((c) => c.tagName === "TD");

  // Lay cells out on a grid honouring rowspan/colspan: grid[r][c] = the cell covering (r, c).
  function buildGrid(rows) {
    const grid = rows.map(() => []);
    rows.forEach((tr, r) => {
      let c = 0;
      for (const cell of tr.cells) {
        while (grid[r][c]) c++;
        const rs =
          cell.rowSpan === 0 ? rows.length - r : Math.max(1, cell.rowSpan || 1);
        const cs = Math.max(1, cell.colSpan || 1);
        for (let i = 0; i < rs && r + i < rows.length; i++) {
          for (let j = 0; j < cs; j++) grid[r + i][c + j] = cell;
        }
        c += cs;
      }
    });
    return grid;
  }

  // Header rows, data rows (with their per-column cells) and section rows of a table.
  // Recomputed on demand, so it follows sorting and rowspan explosion.
  function analyze(table) {
    let headerRows = table.tHead ? rowsOf(table.tHead) : [];
    const groups = Array.from(table.tBodies).map(rowsOf);
    if (!headerRows.length && groups.length) {
      // No <thead>: leading rows without any <td> are the header.
      let k = 0;
      while (k < groups[0].length && !hasTd(groups[0][k])) k++;
      headerRows = groups[0].slice(0, k);
      groups[0] = groups[0].slice(k);
    }
    const data = [];
    const order = []; // body rows in DOM order, with tbody boundaries
    for (const rows of groups) {
      order.push({ boundary: true });
      const grid = buildGrid(rows);
      rows.forEach((tr, i) => {
        if (hasTd(tr)) {
          const entry = { tr, cells: grid[i] };
          data.push(entry);
          order.push(entry);
        } else {
          order.push({ tr, section: true });
        }
      });
    }
    const colCount = data.reduce((m, d) => Math.max(m, d.cells.length), 0);
    const hasRowspan = groups.some((rows) =>
      rows.some((tr) => Array.from(tr.cells).some((c) => c.rowSpan !== 1)),
    );
    return {
      headerRows,
      headerGrid: buildGrid(headerRows),
      groups,
      data,
      order,
      colCount,
      hasRowspan,
    };
  }

  // Column title, combining grouped headers ("Damage" over "Min" -> "Damage Min")
  // and skipping full-width caption rows.
  function columnLabel(model, c) {
    const parts = [];
    for (const row of model.headerGrid) {
      const cell = row[c];
      if (!cell || parts.includes(cell)) continue;
      if (model.colCount > 1 && (cell.colSpan || 1) >= model.colCount) continue;
      parts.push(cell);
    }
    return parts.map(cellText).filter(Boolean).join(" ") || `column ${c + 1}`;
  }

  function detectColumnTypes(model) {
    const step = Math.max(1, Math.floor(model.data.length / SAMPLE_ROWS));
    const sample = model.data
      .filter((_, i) => i % step === 0)
      .slice(0, SAMPLE_ROWS);
    const types = [];
    for (let c = 0; c < model.colCount; c++) {
      let dates = 0,
        nums = 0,
        nonEmpty = 0,
        worded = 0;
      const words = new Set();
      for (const row of sample) {
        const text = cellText(row.cells[c]);
        if (isPlaceholder(text)) continue;
        nonEmpty++;
        if (parseDateValue(text) != null) dates++;
        // A number only counts when no letters come before it: "G1" or "Mk1-Braton" are labels.
        else if (
          parseNumericValue(text) != null &&
          !/[a-z]/i.test(text.split(/\d/)[0])
        ) {
          nums++;
          const w = residualWords(text);
          if (w.length >= 3) {
            worded++;
            words.add(w);
          }
        }
      }
      if (nonEmpty < 3) types.push(null);
      else if (dates / nonEmpty >= 0.8) types.push("date");
      else if (nums / nonEmpty >= 0.8) {
        // Numbers with varying words ("46.30% Electricity") get a range *and* a text box.
        types.push(
          words.size >= 2 && worded / nums >= 0.3 ? "mixed" : "number",
        );
      } else types.push("text");
    }
    return types;
  }

  // Split rowspans into per-row copies so rows can be hidden independently
  // (MediaWiki's tablesorter does the same before sorting).
  function explodeRowspans(model) {
    for (const rows of model.groups) {
      if (!rows.some((tr) => Array.from(tr.cells).some((c) => c.rowSpan !== 1)))
        continue;
      const grid = buildGrid(rows);
      rows.forEach((tr, r) => {
        const seq = [];
        for (const cell of grid[r])
          if (cell && !seq.includes(cell)) seq.push(cell);
        for (const cell of seq) {
          if (cell.parentNode === tr) tr.appendChild(cell);
          else {
            const copy = cell.cloneNode(true);
            copy.rowSpan = 1;
            tr.appendChild(copy);
          }
        }
      });
      rows.forEach((tr) =>
        Array.from(tr.cells).forEach((c) => {
          if (c.rowSpan !== 1) c.rowSpan = 1;
        }),
      );
    }
  }

  // ===================== Formula engine (no eval) =====================
  // Column names are matched loosely: "Crit Dmg", "critdmg", "crit_dmg" and
  // [Crit Dmg] all refer to the same column.
  function normalizeName(s) {
    return String(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function tokenizeFormula(str) {
    const tokens = [];
    let i = 0;
    const isDigit = (c) => c >= "0" && c <= "9";
    const isIdent = (c) => /[\p{L}\p{N}_]/u.test(c);
    while (i < str.length) {
      const c = str[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (isDigit(c) || (c === "." && isDigit(str[i + 1] || ""))) {
        let j = i;
        while (j < str.length && (isDigit(str[j]) || str[j] === ".")) j++;
        const v = Number(str.slice(i, j));
        if (!Number.isFinite(v))
          throw new Error(`bad number "${str.slice(i, j)}"`);
        tokens.push({ t: "num", v });
        i = j;
        continue;
      }
      if (c === "[") {
        const j = str.indexOf("]", i);
        if (j < 0) throw new Error('missing "]"');
        tokens.push({ t: "id", v: str.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      if (isIdent(c)) {
        let j = i;
        while (j < str.length && isIdent(str[j])) j++;
        tokens.push({ t: "id", v: str.slice(i, j) });
        i = j;
        continue;
      }
      const two = str.slice(i, i + 2);
      if ([">=", "<=", "==", "!="].includes(two)) {
        tokens.push({ t: two });
        i += 2;
        continue;
      }
      if (c === "=") {
        tokens.push({ t: "==" });
        i++;
        continue;
      }
      if (c === "−") {
        tokens.push({ t: "-" });
        i++;
        continue;
      }
      if ("+-*/%^(),><".includes(c)) {
        tokens.push({ t: c });
        i++;
        continue;
      }
      throw new Error(`unexpected character "${c}"`);
    }
    return tokens;
  }

  const FUNCS = {
    if: (a) => (a[0] ? a[1] : a[2]),
    min: (a) => Math.min(...a),
    max: (a) => Math.max(...a),
    abs: (a) => Math.abs(a[0]),
    round: (a) => {
      const f = Math.pow(10, a[1] | 0);
      return Math.round(a[0] * f) / f;
    },
    floor: (a) => Math.floor(a[0]),
    ceil: (a) => Math.ceil(a[0]),
    sqrt: (a) => Math.sqrt(a[0]),
  };

  // Precedence, lowest first: comparison < + - < * / % < unary - < ^ (right-assoc).
  function parseFormula(str) {
    const tokens = tokenizeFormula(str);
    if (!tokens.length) throw new Error("the formula is empty");
    let p = 0;
    const peek = () => tokens[p];
    const is = (t) => !!tokens[p] && tokens[p].t === t;
    const next = () => tokens[p++];
    const expect = (t) => {
      if (!is(t)) throw new Error(`expected "${t}"`);
      next();
    };
    const CMP = [">", "<", ">=", "<=", "==", "!="];
    const isCmp = () => !!peek() && CMP.includes(peek().t);

    function parseCmp() {
      const l = parseAdd();
      if (!isCmp()) return l;
      const op = next().t;
      const node = { op, l, r: parseAdd() };
      if (isCmp()) throw new Error("comparisons cannot be chained; use if()");
      return node;
    }
    function parseAdd() {
      let l = parseMul();
      while (is("+") || is("-")) {
        const op = next().t;
        l = { op, l, r: parseMul() };
      }
      return l;
    }
    function parseMul() {
      let l = parseUnary();
      while (is("*") || is("/") || is("%")) {
        const op = next().t;
        l = { op, l, r: parseUnary() };
      }
      return l;
    }
    function parseUnary() {
      if (is("-") || is("+")) {
        const op = next().t;
        return { op, unary: parseUnary() };
      }
      return parsePow();
    }
    function parsePow() {
      const base = parseAtom();
      if (!is("^")) return base;
      next();
      return { op: "^", l: base, r: parseUnary() };
    }
    function parseAtom() {
      const tk = peek();
      if (!tk) throw new Error("the formula ends too early");
      if (tk.t === "num") return { num: next().v };
      if (tk.t === "(") {
        next();
        const e = parseCmp();
        expect(")");
        return e;
      }
      if (tk.t === "id") {
        next();
        if (!is("(")) return { ref: tk.v };
        next();
        const args = [];
        if (!is(")")) {
          args.push(parseCmp());
          while (is(",")) {
            next();
            args.push(parseCmp());
          }
        }
        expect(")");
        return { call: tk.v, args };
      }
      throw new Error(`unexpected "${tk.t}"`);
    }

    const ast = parseCmp();
    if (p !== tokens.length) {
      const tk = tokens[p];
      throw new Error(`unexpected "${tk.v != null ? tk.v : tk.t}"`);
    }
    return ast;
  }

  function evalAst(node, getVar) {
    if (node.num != null) return node.num;
    if (node.ref != null) return getVar(node.ref);
    if (node.call != null)
      return FUNCS[node.call.toLowerCase()](
        node.args.map((a) => evalAst(a, getVar)),
      );
    if (node.unary != null) {
      const v = evalAst(node.unary, getVar);
      return node.op === "-" ? -v : +v;
    }
    const l = evalAst(node.l, getVar),
      r = evalAst(node.r, getVar);
    switch (node.op) {
      case "+":
        return l + r;
      case "-":
        return l - r;
      case "*":
        return l * r;
      case "/":
        return l / r;
      case "%":
        return l % r;
      case "^":
        return Math.pow(l, r);
      case ">":
        return l > r;
      case "<":
        return l < r;
      case ">=":
        return l >= r;
      case "<=":
        return l <= r;
      case "==":
        return l === r;
      case "!=":
        return l !== r;
    }
    throw new Error("unknown operator " + node.op);
  }

  // Parse and check every column/function reference against `names` (normalized name -> column).
  function compileFormula(formula, names) {
    const ast = parseFormula(formula);
    (function check(node) {
      if (node.ref != null) {
        if (!names.has(normalizeName(node.ref)))
          throw new Error(`unknown column "${node.ref}"`);
      } else if (node.call != null) {
        if (!FUNCS[node.call.toLowerCase()])
          throw new Error(`unknown function "${node.call}"`);
        node.args.forEach(check);
      } else if (node.unary != null) check(node.unary);
      else if (node.l) {
        check(node.l);
        check(node.r);
      }
    })(ast);
    return ast;
  }

  function formatNumber(v) {
    if (v == null || !Number.isFinite(v)) return "";
    return String(Math.round(v * 10000) / 10000);
  }

  // ===================== Custom (computed) columns =====================

  function tableIndex(table) {
    return Array.from(document.querySelectorAll(SELECTOR)).indexOf(table);
  }
  function customsKey(index) {
    return `wf-custcols:${location.pathname}:${index}`;
  }
  function loadCustoms(index) {
    try {
      const arr = JSON.parse(localStorage.getItem(customsKey(index)) || "[]");
      return Array.isArray(arr)
        ? arr.filter(
            (c) =>
              c && typeof c.id === "string" && typeof c.formula === "string",
          )
        : [];
    } catch (e) {
      return [];
    }
  }
  function saveCustoms(index, customs) {
    try {
      if (customs.length) {
        localStorage.setItem(
          customsKey(index),
          JSON.stringify(
            customs.map(({ id, name, formula, after }) => ({
              id,
              name,
              formula,
              after,
            })),
          ),
        );
      } else localStorage.removeItem(customsKey(index));
    } catch (e) {
      /* storage unavailable */
    }
  }

  // Final column order: originals in place, each custom column right after its anchor
  // ("start", "end", "o:<original index>" or "c:<custom id>").
  function orderColumns(origCount, applied) {
    const ids = new Set(applied.map((c) => c.id));
    const anchorOf = (c) => {
      const a = String(c.after || "end");
      if (a === "start" || a === "end") return a;
      if (/^o:\d+$/.test(a) && +a.slice(2) < origCount) return a;
      if (a.startsWith("c:") && ids.has(a.slice(2)) && a.slice(2) !== c.id)
        return a;
      return "end";
    };
    const out = [];
    const placed = new Set();
    const placeAfter = (key) => {
      for (const c of applied) {
        if (placed.has(c.id) || anchorOf(c) !== key) continue;
        placed.add(c.id);
        out.push({ custom: c });
        placeAfter("c:" + c.id);
      }
    };
    placeAfter("start");
    for (let i = 0; i < origCount; i++) {
      out.push({ orig: i });
      placeAfter("o:" + i);
    }
    placeAfter("end");
    for (const c of applied) if (!placed.has(c.id)) out.push({ custom: c }); // anchor cycles
    return out;
  }

  function insertIntoRow(tr, rowCells, after, newCell) {
    for (const cell of tr.cells) {
      if (rowCells.indexOf(cell) > after) {
        tr.insertBefore(newCell, cell);
        return;
      }
    }
    tr.appendChild(newCell);
  }

  function makeCustomHeader(custom) {
    const th = document.createElement("th");
    th.className = "wf-custom-head unsortable";
    th.setAttribute("data-wf-custom", custom.id);
    th.title = `${custom.name} = ${custom.formula}`;
    const name = document.createElement("span");
    name.textContent = custom.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "wf-custom-remove";
    remove.title = "Remove column";
    remove.setAttribute("aria-label", `Remove column ${custom.name}`);
    th.append(name, remove);
    return th;
  }

  // Insert one custom column right after visual column `after` (-1 = first),
  // widening any header/caption/body cell that spans across that position.
  function insertColumnAfter(table, after, custom, values) {
    const extended = new Set();
    const extend = (cell) => {
      if (extended.has(cell)) return;
      extended.add(cell);
      cell.colSpan = (cell.colSpan || 1) + 1;
      const ids = (cell.getAttribute("data-wf-ext") || "")
        .split(" ")
        .filter(Boolean);
      ids.push(custom.id);
      cell.setAttribute("data-wf-ext", ids.join(" "));
    };
    const spansPast = (rowCells, cell) => {
      const start = rowCells.indexOf(cell);
      return start <= after && start + (cell.colSpan || 1) - 1 > after;
    };
    const m = analyze(table);

    const H = m.headerRows.length;
    for (let r = 0; r < H; r++) {
      const rowCells = m.headerGrid[r];
      const cell = after >= 0 ? rowCells[after] : null;
      if (cell && spansPast(rowCells, cell) && r < H - 1) {
        extend(cell); // group header above the new column
        continue;
      }
      const th = makeCustomHeader(custom);
      // The wiki only positions its sort arrows on .headerSort cells; without it the
      // headerSortUp/Down arrow image tiles across the whole cell.
      if (table.classList.contains("sortable")) th.classList.add("headerSort");
      th.rowSpan = H - r;
      insertIntoRow(m.headerRows[r], rowCells, after, th);
      break;
    }

    const bodyGroups = m.groups.slice();
    if (table.tFoot) bodyGroups.push(rowsOf(table.tFoot));
    for (const rows of bodyGroups) {
      const grid = buildGrid(rows);
      rows.forEach((tr, r) => {
        const cell = after >= 0 ? grid[r][after] : null;
        if (cell && spansPast(grid[r], cell)) {
          extend(cell);
          return;
        }
        const isData = hasTd(tr) && values.has(tr);
        const el = document.createElement(isData ? "td" : "th"); // keep section rows <td>-free
        el.className = "wf-custom-cell";
        el.setAttribute("data-wf-custom", custom.id);
        if (isData) {
          el.textContent = formatNumber(values.get(tr)[custom.id]);
          el.title = `${custom.name} = ${custom.formula}`;
        }
        insertIntoRow(tr, grid[r], after, el);
      });
    }
  }

  function removeCustomColumns(table) {
    const mine = (el) => el.closest("table") === table;
    table.querySelectorAll("[data-wf-custom]").forEach((el) => {
      if (mine(el)) el.remove();
    });
    table.querySelectorAll("[data-wf-ext]").forEach((el) => {
      if (!mine(el)) return;
      const n = el
        .getAttribute("data-wf-ext")
        .split(" ")
        .filter(Boolean).length;
      el.colSpan = Math.max(1, (el.colSpan || 1) - n);
      el.removeAttribute("data-wf-ext");
    });
  }

  function namesFor(labels) {
    const names = new Map();
    labels.forEach((label, i) => {
      const k = normalizeName(label);
      if (k && !names.has(k)) names.set(k, { orig: i });
    });
    return names;
  }

  // Validate the stored custom columns, compute their values for every data row and
  // insert them. Returns the applied columns, problems, and the final column order.
  function applyCustomColumns(table, model, customs, origLabels) {
    const names = namesFor(origLabels);
    const applied = [];
    const errors = [];
    for (const c of customs) {
      try {
        const ast = compileFormula(c.formula, names);
        applied.push(Object.assign({}, c, { ast }));
        const k = normalizeName(c.name);
        if (k && !names.has(k)) names.set(k, { custom: c.id });
      } catch (e) {
        errors.push(`${c.name}: ${e.message}`);
      }
    }
    if (!applied.length) return { applied, errors, order: null };

    if (model.hasRowspan) {
      explodeRowspans(model);
      model = analyze(table);
    }
    const values = new Map();
    for (const d of model.data) {
      const vals = {};
      const getVar = (name) => {
        const ref = names.get(normalizeName(name));
        if (!ref) return NaN;
        if (ref.custom)
          return vals[ref.custom] == null ? NaN : vals[ref.custom];
        const n = parseNumericValue(cellText(d.cells[ref.orig]));
        return n == null ? NaN : n; // no number in the cell -> empty result
      };
      for (const c of applied) {
        let v;
        try {
          v = Number(evalAst(c.ast, getVar));
        } catch (e) {
          v = NaN;
        }
        vals[c.id] = v;
      }
      values.set(d.tr, vals);
    }
    const order = orderColumns(model.colCount, applied);
    let pos = -1;
    for (const entry of order) {
      if (entry.custom) insertColumnAfter(table, pos, entry.custom, values);
      pos++;
    }
    return { applied, errors, order };
  }

  // MediaWiki's tablesorter maps headers to cell positions once, so after a column is
  // inserted it would sort the wrong column. Tables with custom columns sort here instead.
  function sortByColumn(st, model, c, dir) {
    const type = st.types[c];
    const key = (cell) => {
      if (!cell) return null;
      const sv = cell.getAttribute("data-sort-value");
      const text = sv != null && sv.trim() !== "" ? sv.trim() : cellText(cell);
      if (type === "number" || type === "mixed") return parseNumericValue(text);
      if (type === "date") return parseDateValue(text);
      return text ? text.toLowerCase() : null;
    };
    const mult = dir === "asc" ? 1 : -1;
    for (const rows of model.groups) {
      const grid = buildGrid(rows);
      const data = rows
        .map((tr, i) => ({ tr, k: key(grid[i][c]) }))
        .filter((x) => hasTd(x.tr));
      data.sort((a, b) => {
        if (a.k == null || b.k == null)
          return a.k == null ? (b.k == null ? 0 : 1) : -1; // blanks last
        if (typeof a.k === "string")
          return mult * a.k.localeCompare(b.k, undefined, { numeric: true });
        return mult * (a.k - b.k);
      });
      const parent = rows.length && rows[0].parentNode;
      if (parent) data.forEach((x) => parent.appendChild(x.tr));
    }
  }

  function onHeaderClick(e) {
    const table = e.currentTarget;
    const st = states.get(table);
    if (!st || !st.applied.length || !table.classList.contains("sortable"))
      return;
    if (e.target.closest("a, button, input, select, textarea")) return;
    const th = e.target.closest("th");
    if (!th || th.closest("table") !== table) return;
    const model = analyze(table);
    const r = model.headerRows.indexOf(th.parentNode);
    if (r < 0 || (th.colSpan || 1) !== 1) return;
    if (
      th.classList.contains("unsortable") &&
      !th.hasAttribute("data-wf-custom")
    )
      return;
    const c = model.headerGrid[r].indexOf(th);
    if (c < 0) return;
    e.stopPropagation(); // keep tablesorter's stale column mapping out of it
    e.preventDefault();
    const dir = st.sortCol === c && st.sortDir === "asc" ? "desc" : "asc";
    st.sortCol = c;
    st.sortDir = dir;
    sortByColumn(st, model, c, dir);
    for (const row of model.headerRows) {
      for (const cell of row.cells) {
        cell.classList.remove("headerSortUp", "headerSortDown");
        cell.removeAttribute("aria-sort");
      }
    }
    th.classList.add(dir === "asc" ? "headerSortUp" : "headerSortDown");
    th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
  }

  // ===================== Theming =====================

  function readColor(el, prop) {
    const v = getComputedStyle(el)[prop] || "";
    const m = v.match(
      /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/,
    );
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
  }
  function luminance(c) {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  }
  function toCss(c, a) {
    return a == null
      ? `rgb(${c.r}, ${c.g}, ${c.b})`
      : `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
  }
  function mix(a, b, t) {
    return {
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t),
      a: 1,
    };
  }

  function styleTable(table, headerTh, bodyCell) {
    // Base background: prefer a real body cell (rows are transparent on the table bg).
    let bg = bodyCell ? readColor(bodyCell, "backgroundColor") : null;
    if (!bg || bg.a === 0) bg = readColor(table, "backgroundColor");
    if (!bg || bg.a === 0) bg = { r: 24, g: 51, b: 73, a: 1 }; // safe fallback

    let text = headerTh ? readColor(headerTh, "color") : null;
    if (!text) text = readColor(table, "color");
    if (!text) text = { r: 213, g: 213, b: 213, a: 1 };

    let border =
      (headerTh && readColor(headerTh, "borderBottomColor")) ||
      readColor(table, "borderTopColor");
    if (!border) border = mix(bg, { r: 255, g: 255, b: 255, a: 1 }, 0.15);

    const dark = luminance(bg) < 140;
    const base = dark
      ? { r: 0, g: 0, b: 0, a: 1 }
      : { r: 255, g: 255, b: 255, a: 1 };

    const input = mix(bg, base, dark ? 0.3 : 0.06); // sunken field
    const controls = mix(bg, base, dark ? 0.15 : 0.04); // toolbar band
    const muted = mix(text, bg, 0.34); // softer labels / count
    const accent = dark
      ? mix(border, { r: 255, g: 255, b: 255, a: 1 }, 0.4)
      : mix(border, { r: 0, g: 0, b: 0, a: 1 }, 0.1);
    const hover = mix(input, accent, 0.22);
    const ring = { r: accent.r, g: accent.g, b: accent.b, a: 1 };
    const badgeFg =
      luminance(accent) > 150 ? toCss({ r: 8, g: 22, b: 34, a: 1 }) : "#fff";

    table.style.setProperty("--wf-bg", toCss(bg));
    table.style.setProperty("--wf-text", toCss(text));
    table.style.setProperty("--wf-border", toCss(border));
    table.style.setProperty("--wf-input", toCss(input));
    table.style.setProperty("--wf-controls", toCss(controls));
    table.style.setProperty("--wf-muted", toCss(muted));
    table.style.setProperty("--wf-accent", toCss(accent));
    table.style.setProperty("--wf-hover", toCss(hover));
    table.style.setProperty("--wf-ring", toCss(ring, 0.32));
    table.style.setProperty("--wf-scheme", dark ? "dark" : "light");
    table.style.setProperty("--wf-badge-fg", badgeFg);
    table.style.setProperty("--wf-error", dark ? "#fca5a5" : "#b91c1c");
  }

  // The wiki's "stickyHeader" tables pin every <thead> row at the same `top`, so
  // extra header rows would pile on top of each other. Stack them instead.
  function syncSticky(st) {
    const thead = st.table.tHead;
    if (!thead || !thead.rows.length || !thead.rows[0].cells.length) return;
    if (st.stickyBase == null) {
      const cs = getComputedStyle(thead.rows[0].cells[0]);
      if (cs.position !== "sticky") return;
      st.stickyBase = parseFloat(cs.top) || 0;
    }
    let top = st.stickyBase;
    for (const row of thead.rows) {
      for (const cell of row.cells) {
        if (cell.parentNode === row)
          cell.style.setProperty("top", top + "px", "important");
      }
      top += row.getBoundingClientRect().height;
    }
  }

  // ===================== Filtering =====================

  const isActive = (f) => f.min != null || f.max != null || !!f.text;

  function rowMatches(cells, st) {
    for (let i = 0; i < st.filters.length; i++) {
      const f = st.filters[i];
      if (!isActive(f)) continue;
      const text = cellText(cells[i]);
      if (f.text && !text.toLowerCase().includes(f.text.toLowerCase()))
        return false;
      if (f.min == null && f.max == null) continue;
      const v =
        st.types[i] === "date" ? parseDateValue(text) : parseNumericValue(text);
      if (v == null) return false;
      if (f.min != null && v < f.min) return false;
      if (f.max != null && v > f.max) return false;
    }
    return true;
  }

  function applyFilters(st) {
    const activeCount = st.filters.filter(isActive).length;
    let model = analyze(st.table);
    if (activeCount && model.hasRowspan) {
      explodeRowspans(model);
      model = analyze(st.table);
    }
    let shown = 0,
      total = 0;
    let section = null,
      sectionShown = false;
    const closeSection = () => {
      if (section)
        section.style.display = !activeCount || sectionShown ? "" : "none";
      section = null;
    };
    for (const entry of model.order) {
      if (entry.boundary || entry.section) {
        closeSection();
        if (entry.section) {
          section = entry.tr;
          sectionShown = false;
        }
        continue;
      }
      total++;
      const visible = !activeCount || rowMatches(entry.cells, st);
      entry.tr.style.display = visible ? "" : "none";
      if (visible) {
        shown++;
        sectionShown = true;
      }
    }
    closeSection();
    st.countEl.textContent = `Showing ${shown} of ${total} rows`;
    st.badgeEl.textContent = String(activeCount);
    st.badgeEl.hidden = !activeCount;
    syncSticky(st);
  }

  // ===================== Persistence (per tab, survives reloads) =====================

  function storageKey(st) {
    return `wf-filters:${location.pathname}:${st.index}`;
  }
  // Filters are stored per column identity ("o:3" = 4th original column, "c:<id>" = a
  // custom column), so they survive adding or removing custom columns.
  function saveState(st) {
    try {
      const data = {};
      st.columns.forEach((col, i) => {
        if (!col) return;
        const v = col.inputs.map((el) => el.value);
        if (v.some(Boolean)) data[st.keys[i]] = v;
      });
      if (Object.keys(data).length)
        sessionStorage.setItem(storageKey(st), JSON.stringify(data));
      else sessionStorage.removeItem(storageKey(st));
    } catch (e) {
      /* storage unavailable */
    }
  }
  function restoreState(st) {
    try {
      const data = JSON.parse(sessionStorage.getItem(storageKey(st)) || "null");
      if (!data) return;
      for (const [key, values] of Object.entries(data)) {
        const col = st.columns[st.keys.indexOf(key)];
        if (!col || !Array.isArray(values)) continue;
        col.inputs.forEach((el, k) => {
          el.value = values[k] || "";
        });
        col.read();
      }
    } catch (e) {
      /* ignore corrupt state */
    }
  }

  // ===================== UI =====================

  function makeInput(type, cls, placeholder, label) {
    const el = document.createElement("input");
    el.className = "wf-filter-input " + cls;
    el.type = type;
    if (type === "number") el.step = "any";
    if (placeholder) el.placeholder = placeholder;
    el.title = "Esc or right-click to clear";
    el.setAttribute("aria-label", label);
    return el;
  }

  function buildColumnFilter(st, i, type, label) {
    const isDate = type === "date";
    const wrap = document.createElement("div");
    wrap.className = "wf-filter-wrap wf-kind-" + type;
    const inputs = [];
    let from = null,
      to = null,
      text = null;
    if (type !== "text") {
      const row = document.createElement("div");
      row.className = "wf-filter-inputs";
      const kind = isDate ? "date" : "number";
      from = makeInput(kind, "wf-from", "From", `Filter ${label} from`);
      to = makeInput(kind, "wf-to", "To", `Filter ${label} to`);
      row.append(from, to);
      wrap.appendChild(row);
      inputs.push(from, to);
    }
    if (type === "text" || type === "mixed") {
      const row = document.createElement("div");
      row.className = "wf-filter-inputs";
      text = makeInput("text", "wf-text", "Contains", `Filter ${label} text`);
      row.appendChild(text);
      wrap.appendChild(row);
      inputs.push(text);
    }

    const parse = (el) => {
      if (!el || !el.value) return null;
      if (isDate) {
        const t = Date.parse(el.value + "T00:00:00Z");
        return Number.isNaN(t) ? null : t;
      }
      const n = Number(el.value);
      return Number.isFinite(n) ? n : null;
    };
    const f = st.filters[i];
    const read = () => {
      let lo = parse(from),
        hi = parse(to);
      if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo]; // forgive reversed bounds
      if (isDate && hi != null) hi += DAY - 1; // "To" covers the whole day
      f.min = lo;
      f.max = hi;
      f.text = text ? text.value.trim() : "";
      inputs.forEach((el) => el.classList.toggle("wf-has-value", !!el.value));
    };
    const update = () => {
      read();
      applyFilters(st);
      saveState(st);
    };
    const hasValue = () => inputs.some((el) => el.value);
    const clear = () => {
      inputs.forEach((el) => {
        el.value = "";
      });
      update();
    };

    for (const el of inputs) {
      el.addEventListener("input", update);
      el.addEventListener("change", update);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && hasValue()) {
          e.preventDefault();
          clear();
        }
      });
      // Right-click clears a filled column; on an empty one the normal menu (paste) stays.
      el.addEventListener("contextmenu", (e) => {
        if (!hasValue()) return;
        e.preventDefault();
        e.stopPropagation();
        clear();
      });
      if (el.type === "number") {
        // Scrolling the page over a focused number field must not change the filter.
        el.addEventListener(
          "wheel",
          () => {
            if (document.activeElement === el) el.blur();
          },
          { passive: true },
        );
      }
    }
    st.columns[i] = { inputs, read };
    return wrap;
  }

  function enhance(table) {
    let model = analyze(table);
    if (model.colCount < 2 || model.data.length < MIN_ROWS) return false;
    const index = tableIndex(table);
    const origCount = model.colCount;
    const origLabels = Array.from({ length: origCount }, (_, c) =>
      columnLabel(model, c),
    );

    // Computed columns go in first, so they are filtered and sorted like any other column.
    const customs = loadCustoms(index);
    let custom = { applied: [], errors: [], order: null };
    if (customs.length) {
      custom = applyCustomColumns(table, model, customs, origLabels);
      model = analyze(table);
    }
    const keys =
      custom.order && custom.order.length === model.colCount
        ? custom.order.map((e) =>
            e.custom ? "c:" + e.custom.id : "o:" + e.orig,
          )
        : Array.from({ length: model.colCount }, (_, c) => "o:" + c);

    const types = detectColumnTypes(model);
    if (!types.some(Boolean)) {
      removeCustomColumns(table);
      return false;
    }

    injectStyles();
    table.setAttribute(MARK, "true");
    const firstHeader = model.headerRows.length
      ? model.headerRows[0].cells[0]
      : null;
    styleTable(table, firstHeader, model.data[0].tr.cells[0]);

    const st = {
      table,
      index,
      types,
      keys,
      origLabels,
      customs,
      applied: custom.applied,
      filters: types.map(() => ({ min: null, max: null, text: "" })),
      columns: [],
    };
    states.set(table, st);

    const ownTh = () => {
      const th = document.createElement("th");
      th.className = "sorter-false unsortable";
      th.setAttribute("data-sorter", "false");
      return th;
    };

    // Controls row
    const controlsRow = document.createElement("tr");
    controlsRow.className = "wf-filter-controls sorter-false sorttop";
    const controlsTh = ownTh();
    controlsTh.colSpan = model.colCount;
    controlsTh.innerHTML = `<div class="wf-controls-inner"><div class="wf-filter-bar">
      <span><strong>Filters</strong><span class="wf-filter-badge" title="Active filters" hidden>0</span></span>
      <span class="wf-filter-count" aria-live="polite"></span>
      <button type="button" class="wf-filter-btn wf-filter-clear">Clear filters</button>
      <button type="button" class="wf-filter-btn wf-custom-toggle" aria-expanded="false">+ Column</button>
      <span class="wf-filter-hint">Esc or right-click clears a field</span>
    </div>
    <div class="wf-custom-msg" role="status" hidden></div>
    <form class="wf-custom-form" hidden>
      <input class="wf-filter-input wf-custom-name" type="text" placeholder="Name" aria-label="New column name">
      <span>=</span>
      <input class="wf-filter-input wf-custom-formula" type="text" aria-label="Formula"
        placeholder="e.g. Normal * (1 + Crit / 100 * ([Crit Dmg] - 1))">
      <select class="wf-filter-input wf-custom-after" aria-label="Position"></select>
      <button type="submit" class="wf-filter-btn wf-custom-add">Add column</button>
      <button type="button" class="wf-filter-btn wf-custom-cancel">Cancel</button>
      <span class="wf-custom-error" role="alert"></span>
      <div class="wf-custom-help">Refer to columns by name (spaces and symbols are ignored, or write
        [Exact Name]). Operators: + − * / % ^ and comparisons &gt; &lt; &gt;= &lt;= == !=.
        Functions: if(condition, a, b), min, max, abs, round(x, digits), floor, ceil, sqrt.
        Rows where a referenced cell has no number stay empty.</div>
    </form></div>`;
    controlsRow.appendChild(controlsTh);
    st.countEl = controlsTh.querySelector(".wf-filter-count");
    st.badgeEl = controlsTh.querySelector(".wf-filter-badge");
    if (custom.errors.length) {
      const msg = controlsTh.querySelector(".wf-custom-msg");
      msg.textContent =
        "Some saved columns could not be shown — " + custom.errors.join("; ");
      msg.hidden = false;
    }
    setupCustomForm(st, controlsTh, model);

    // Filter input row
    const filterRow = document.createElement("tr");
    filterRow.className = "wf-filter-row sorter-false sorttop";
    types.forEach((type, i) => {
      const th = ownTh();
      if (!type) {
        const none = document.createElement("span");
        none.className = "wf-filter-none";
        none.textContent = "—";
        th.appendChild(none);
      } else {
        th.appendChild(buildColumnFilter(st, i, type, columnLabel(model, i)));
      }
      filterRow.appendChild(th);
    });

    // Interacting with the filters must never trigger tablesorter.
    for (const row of [filterRow, controlsRow]) {
      row.addEventListener("click", (e) => e.stopPropagation());
      row.addEventListener("mousedown", (e) => e.stopPropagation());
    }
    controlsTh
      .querySelector(".wf-filter-clear")
      .addEventListener("click", () => {
        st.columns.forEach((col) => {
          if (col) {
            col.inputs.forEach((el) => {
              el.value = "";
            });
            col.read();
          }
        });
        applyFilters(st);
        saveState(st);
      });

    // Remove buttons in custom column headers.
    table.querySelectorAll(".wf-custom-remove").forEach((btn) => {
      if (btn.closest("table") !== table) return;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        removeCustom(
          st,
          btn.closest("[data-wf-custom]").getAttribute("data-wf-custom"),
        );
      });
    });
    if (!sortHooked.has(table)) {
      sortHooked.add(table);
      table.addEventListener("click", onHeaderClick, true);
    }

    // Insert after the last header row: the wiki draws sort icons on the first
    // header row, so that one must stay first.
    const last = model.headerRows[model.headerRows.length - 1];
    if (last) {
      last.parentNode.insertBefore(controlsRow, last.nextSibling);
    } else {
      const body = table.tBodies[0];
      body.insertBefore(controlsRow, body.firstChild);
    }
    controlsRow.parentNode.insertBefore(filterRow, controlsRow.nextSibling);

    restoreState(st);
    applyFilters(st);

    if (table.tHead && typeof ResizeObserver === "function") {
      st.ro = new ResizeObserver(() => syncSticky(st));
      Array.from(table.tHead.rows).forEach((r) => st.ro.observe(r));
    }
    return true;
  }

  function setupCustomForm(st, controlsTh, model) {
    const toggle = controlsTh.querySelector(".wf-custom-toggle");
    const form = controlsTh.querySelector(".wf-custom-form");
    const nameEl = form.querySelector(".wf-custom-name");
    const formulaEl = form.querySelector(".wf-custom-formula");
    const afterEl = form.querySelector(".wf-custom-after");
    const errorEl = form.querySelector(".wf-custom-error");

    const option = (value, text) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      afterEl.appendChild(o);
    };
    option("end", "at the end");
    option("start", "at the start");
    st.keys.forEach((key, c) => option(key, "after " + columnLabel(model, c)));

    const open = (show) => {
      form.hidden = !show;
      toggle.setAttribute("aria-expanded", String(show));
      errorEl.textContent = "";
      if (show) formulaEl.focus();
      syncSticky(st);
    };
    toggle.addEventListener("click", () => open(form.hidden));
    form
      .querySelector(".wf-custom-cancel")
      .addEventListener("click", () => open(false));
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        open(false);
      }
    });
    [nameEl, formulaEl].forEach((el) =>
      el.addEventListener("input", () => {
        errorEl.textContent = "";
      }),
    );

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = nameEl.value.trim() || `Custom ${st.customs.length + 1}`;
      const formula = formulaEl.value.trim();
      try {
        const names = namesFor(st.origLabels);
        for (const c of st.applied) {
          const k = normalizeName(c.name);
          if (k && !names.has(k)) names.set(k, { custom: c.id });
        }
        if (names.has(normalizeName(name)))
          throw new Error(`a column named "${name}" already exists`);
        compileFormula(formula, names);
      } catch (err) {
        errorEl.textContent = "Can't add column: " + err.message;
        return;
      }
      const id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      st.customs.push({ id, name, formula, after: afterEl.value });
      saveCustoms(st.index, st.customs);
      rebuild(st);
    });
  }

  function removeCustom(st, id) {
    const gone = st.customs.find((c) => c.id === id);
    if (!gone) return;
    // Columns placed after the removed one take over its position.
    st.customs = st.customs
      .filter((c) => c.id !== id)
      .map((c) =>
        c.after === "c:" + id ? Object.assign({}, c, { after: gone.after }) : c,
      );
    saveCustoms(st.index, st.customs);
    rebuild(st);
  }

  // Re-create the filter UI after the set of custom columns changed.
  function rebuild(st) {
    saveState(st);
    cleanup(st.table);
    enhance(st.table);
  }

  function cleanup(table) {
    const st = states.get(table);
    if (st && st.ro) st.ro.disconnect();
    states.delete(table);
    table.removeAttribute(MARK);
    for (const section of [table.tHead, ...table.tBodies]) {
      if (!section) continue;
      Array.from(section.rows)
        .filter(isOwnRow)
        .forEach((r) => r.remove());
    }
    removeCustomColumns(table);
  }

  // Sortable tables are set up by MediaWiki's tablesorter, which reads the header
  // rows. Wait for it, so our rows are never mistaken for sortable headers.
  const waiting = new WeakSet();
  function whenSorterReady(table, cb) {
    const needsWait =
      window.mw &&
      table.classList.contains("sortable") &&
      !table.classList.contains("jquery-tablesorter");
    if (!needsWait) return cb();
    if (waiting.has(table)) return;
    waiting.add(table);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      mo.disconnect();
      clearTimeout(timer);
      waiting.delete(table);
      cb();
    };
    const mo = new MutationObserver(() => {
      if (table.classList.contains("jquery-tablesorter")) finish();
    });
    mo.observe(table, { attributes: true, attributeFilter: ["class"] });
    const timer = setTimeout(finish, SORTER_WAIT_MS);
  }

  function enhanceTable(table) {
    if (!table || table.getAttribute(MARK)) return;
    whenSorterReady(table, () => {
      if (table.getAttribute(MARK) || !table.isConnected) return;
      try {
        enhance(table);
      } catch (e) {
        // One unusual table must never stop the others from getting filters.
        console.warn(
          "[wf-table-filters] could not add filters to a table:",
          e,
          table,
        );
        cleanup(table);
      }
    });
  }

  function run() {
    document.querySelectorAll(SELECTOR).forEach(enhanceTable);
  }

  run();
  // Tables can appear later (tabbers, collapsibles, live previews): keep watching.
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (
          n.nodeType !== 1 ||
          n.tagName === "TD" ||
          n.tagName === "TH" ||
          n.tagName === "TR"
        )
          continue;
        if (n.matches(SELECTOR)) enhanceTable(n);
        n.querySelectorAll(SELECTOR).forEach(enhanceTable);
      }
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
