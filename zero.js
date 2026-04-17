// ==UserScript==
// @name         ZERO Grid Assistant v0.6
// @namespace    local.zero.grid.assistant
// @version      0.6.0
// @description  Assistives Grid-Overlay mit URL-basierten Orderlinks, 500€-Mindestvolumen, Auto-Bestandslesung und Selector-Debugger
// @match        https://mein.finanzen-zero.net/*
// @match        https://*.finanzen-zero.net/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    minNotional: 500,
    preferGermanDecimal: false,
    autoReadHolding: true,
    symbol: 'US0079031078',
    anchor: 236.00,
    step: 0.50,
    qty: 1,
    manualAvailableQty: '',
    orderPath: '/meindepot/kaufenverkaufen',
    openLinksInNewTab: true,

    selectors: {
      positionContainers: [
        'tr',
        '[role="row"]',
        '[data-testid*="position"]',
        '[data-testid*="Position"]',
        '[data-testid*="holding"]',
        '[data-testid*="Holding"]',
        '[class*="position"]',
        '[class*="Position"]',
        '[class*="holding"]',
        '[class*="Holding"]',
        'article',
        'li',
        'section',
        'div'
      ]
    }
  };

  const state = {
    symbol: CONFIG.symbol,
    anchor: CONFIG.anchor,
    step: CONFIG.step,
    qty: CONFIG.qty,
    manualAvailableQty: CONFIG.manualAvailableQty,
    autoAvailableQty: null,
    lastPrice: null,
    panelOpen: true,
    lastHoldingScan: 'Noch nicht gesucht',
    selectorDebugActive: false,
    lastSelectorInfo: null,
    hoverTarget: null,
    lastBuyUrl: '',
    lastSellUrl: ''
  };

  const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

  function round2(v) {
    return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  }

  function visible(el) {
    if (!el) return false;
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function qsa(list, root = document) {
    const out = [];
    for (const sel of list) {
      try {
        root.querySelectorAll(sel).forEach(el => out.push(el));
      } catch (_) {}
    }
    return [...new Set(out)];
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalizeText(s) {
    return String(s || '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function parseLocalizedNumber(raw) {
    let s = String(raw || '').trim();
    if (!s) return NaN;

    s = s.replace(/\u00A0/g, ' ').replace(/\s+/g, '');
    const hasComma = s.includes(',');
    const hasDot = s.includes('.');

    if (hasComma && hasDot) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasComma) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      const parts = s.split('.');
      if (parts.length > 2) s = parts.join('');
    }

    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function cssEscapeSafe(v) {
    try {
      return CSS.escape(v);
    } catch (_) {
      return String(v).replace(/["\\]/g, '\\$&');
    }
  }

  function grid(anchor, step) {
    anchor = round2(anchor);
    step = round2(step);
    return {
      buy: round2(anchor - step),
      sell: round2(anchor + step),
      nextAnchorAfterSell: round2(anchor + step),
      nextBuyAfterSell: round2(anchor),
      nextSellAfterSell: round2(anchor + step * 2)
    };
  }

  function minQtyForNotional(price, minNotional = CONFIG.minNotional) {
    price = Number(price || 0);
    if (!Number.isFinite(price) || price <= 0) return 1;
    return Math.max(1, Math.ceil(minNotional / price));
  }

  function getEffectiveAvailableQty() {
    const manual = parseLocalizedNumber(state.manualAvailableQty);
    if (Number.isFinite(manual) && manual >= 0) return manual;
    return Number.isFinite(state.autoAvailableQty) ? state.autoAvailableQty : null;
  }

  function requiredBuyQty(price) {
    return Math.max(Number(state.qty || 0), minQtyForNotional(price));
  }

  function requiredSellQty(price) {
    return Math.max(Number(state.qty || 0), minQtyForNotional(price));
  }

  function canSellAt500(price) {
    const required = requiredSellQty(price);
    const available = getEffectiveAvailableQty();
    if (available == null) return { ok: true, required, available: null };
    return { ok: available >= required, required, available };
  }

  function flash(msg, type = 'ok') {
    const el = byId('zga-flash');
    if (!el) return;
    el.textContent = msg;
    el.dataset.type = type;
    el.hidden = false;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function buildNeedles() {
    const raw = String(state.symbol || '').trim();
    if (!raw) return [];
    return raw
      .split(/[|,/ ]+/)
      .map(s => normalizeText(s))
      .filter(Boolean);
  }

  function scoreCandidate(text, needles) {
    let score = 0;
    for (const n of needles) {
      if (text.includes(n)) score += 5;
    }
    if (/\b(bestand|stück|stk|menge|position|anteile?)\b/i.test(text)) score += 3;
    score -= Math.min(text.length / 400, 3);
    return score;
  }

  function extractQtyFromText(text) {
    const patterns = [
      /(?:bestand|verfügbar(?:er bestand)?|stückzahl|menge|position)\s*[:\-]?\s*([0-9][0-9.\s,]*)/i,
      /([0-9][0-9.\s,]*)\s*(?:stk|stück|anteile?)\b/i,
      /\b([0-9][0-9.\s,]*)\b(?=.*\b(?:stk|stück|anteile?|bestand)\b)/i
    ];

    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) {
        const n = parseLocalizedNumber(m[1]);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return null;
  }

  function readAvailableQtyAuto() {
    const needles = buildNeedles();
    if (!needles.length) {
      state.autoAvailableQty = null;
      state.lastHoldingScan = 'Kein Suchbegriff gesetzt';
      updateView();
      return null;
    }

    const all = qsa(CONFIG.selectors.positionContainers)
      .filter(visible)
      .map(el => ({ el, text: normalizeText(el.innerText || el.textContent || '') }))
      .filter(x => x.text.length >= 10);

    const matched = all
      .filter(x => needles.some(n => x.text.includes(n)))
      .map(x => ({ ...x, score: scoreCandidate(x.text, needles) }))
      .sort((a, b) => b.score - a.score);

    for (const candidate of matched) {
      const scopes = [candidate.el];
      let p = candidate.el.parentElement;
      let depth = 0;
      while (p && depth < 3) {
        scopes.push(p);
        p = p.parentElement;
        depth++;
      }

      for (const scope of scopes) {
        const txt = normalizeText(scope.innerText || scope.textContent || '');
        const qty = extractQtyFromText(txt);
        if (Number.isFinite(qty)) {
          state.autoAvailableQty = qty;
          state.lastHoldingScan = `Bestand automatisch erkannt: ${qty} Stk`;
          updateView();
          return qty;
        }
      }
    }

    state.autoAvailableQty = null;
    state.lastHoldingScan = `Kein Bestand für "${state.symbol}" erkannt`;
    updateView();
    return null;
  }

  function buildOrderUrl({ isin, direction, quantity, execType = 'limit', limitPrice }) {
    const url = new URL(CONFIG.orderPath, location.origin);
    url.searchParams.set('isin', String(isin).trim());
    url.searchParams.set('direction', String(direction).trim());
    url.searchParams.set('quantity', String(quantity).trim());
    url.searchParams.set('execType', String(execType).trim());
    url.searchParams.set('limitPrice', String(round2(limitPrice)));
    return url.toString();
  }

  function computeOrder(side) {
    const g = grid(state.anchor, state.step);
    const price = side === 'buy' ? g.buy : g.sell;
    const quantity = side === 'buy' ? requiredBuyQty(price) : requiredSellQty(price);
    const notional = round2(price * quantity);

    return {
      side,
      isin: String(state.symbol || '').trim(),
      price,
      quantity,
      notional,
      url: buildOrderUrl({
        isin: String(state.symbol || '').trim(),
        direction: side,
        quantity,
        execType: 'limit',
        limitPrice: price
      })
    };
  }

  function openPreparedOrder(side) {
    const order = computeOrder(side);

    if (!order.isin) {
      flash('Bitte eine ISIN eintragen.', 'warn');
      return;
    }

    if (side === 'sell') {
      const sellCheck = canSellAt500(order.price);
      if (!sellCheck.ok) {
        flash(
          `Verkauf blockiert: Für ${fmt.format(CONFIG.minNotional)} bei ${fmt.format(order.price)} brauchst du ${sellCheck.required} Stk, verfügbar sind nur ${sellCheck.available} Stk.`,
          'error'
        );
        return;
      }
    }

    if (CONFIG.openLinksInNewTab) window.open(order.url, '_blank', 'noopener');
    else location.href = order.url;

    flash(
      `${side === 'buy' ? 'Kauf' : 'Verkauf'}-Link geöffnet: ${fmt.format(order.price)} × ${order.quantity} = ${fmt.format(order.notional)}. Bitte manuell prüfen und freigeben.`,
      'ok'
    );
  }

  function copyOrderUrl(side) {
    const order = computeOrder(side);
    if (!order.isin) {
      flash('Bitte eine ISIN eintragen.', 'warn');
      return;
    }
    navigator.clipboard.writeText(order.url).then(() => flash(`${side === 'buy' ? 'Kauf' : 'Verkauf'}-URL kopiert.`, 'ok'));
  }

  function copyPlan() {
    const g = grid(state.anchor, state.step);
    const buy = computeOrder('buy');
    const sell = computeOrder('sell');
    const available = getEffectiveAvailableQty();

    const text =
`ISIN: ${buy.isin}
Anchor: ${state.anchor.toFixed(2)}
Abstand: ${state.step.toFixed(2)}

Kauf:
- Preis: ${buy.price.toFixed(2)}
- Menge für >= ${CONFIG.minNotional} €: ${buy.quantity}
- Volumen: ${buy.notional.toFixed(2)} €
- URL: ${buy.url}

Verkauf:
- Preis: ${sell.price.toFixed(2)}
- Menge für >= ${CONFIG.minNotional} €: ${sell.quantity}
- Volumen: ${sell.notional.toFixed(2)} €
- Verfügbarer Bestand: ${available == null ? 'unbekannt' : available}
- URL: ${sell.url}

Nach Verkauf bei ${g.sell.toFixed(2)}:
- Neue Kauforder auf ${g.nextBuyAfterSell.toFixed(2)}
- Neue Verkaufsorder auf ${g.nextSellAfterSell.toFixed(2)}

Hinweis:
- Finale Prüfung und Freigabe immer manuell
- Kein Auto-Submit`;

    navigator.clipboard.writeText(text).then(() => flash('Ablauf kopiert.', 'ok'));
  }

  function describeElement(el) {
    const attrs = ['id', 'name', 'type', 'placeholder', 'aria-label', 'role', 'data-testid'];
    const out = [];
    for (const a of attrs) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) out.push(`${a}="${v}"`);
    }
    return out.join(' | ') || '<keine markanten Attribute>';
  }

  function uniqueSelectorTest(sel, el) {
    try {
      const nodes = document.querySelectorAll(sel);
      return nodes.length === 1 && nodes[0] === el;
    } catch (_) {
      return false;
    }
  }

  function buildNthOfTypeSelector(el) {
    const parts = [];
    let cur = el;

    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      const siblings = Array.from(cur.parentElement?.children || []).filter(x => x.tagName === cur.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        part += `:nth-of-type(${idx})`;
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (_) {}
      cur = cur.parentElement;
    }

    return parts.join(' > ');
  }

  function buildCandidateSelectors(el) {
    const cands = [];
    const tag = el.tagName.toLowerCase();

    if (el.id) cands.push(`#${cssEscapeSafe(el.id)}`);

    const dt = el.getAttribute('data-testid');
    if (dt) cands.push(`[data-testid="${cssEscapeSafe(dt)}"]`);

    const name = el.getAttribute('name');
    if (name) cands.push(`${tag}[name="${cssEscapeSafe(name)}"]`);

    const aria = el.getAttribute('aria-label');
    if (aria) cands.push(`${tag}[aria-label="${cssEscapeSafe(aria)}"]`);

    const ph = el.getAttribute('placeholder');
    if (ph) cands.push(`${tag}[placeholder="${cssEscapeSafe(ph)}"]`);

    const type = el.getAttribute('type');
    if (type) cands.push(`${tag}[type="${cssEscapeSafe(type)}"]`);

    const cls = Array.from(el.classList || []).filter(c => c && !/\d{3,}/.test(c)).slice(0, 3);
    if (cls.length) cands.push(`${tag}.${cls.map(cssEscapeSafe).join('.')}`);

    if (name && type) cands.push(`${tag}[name="${cssEscapeSafe(name)}"][type="${cssEscapeSafe(type)}"]`);
    if (name && ph) cands.push(`${tag}[name="${cssEscapeSafe(name)}"][placeholder="${cssEscapeSafe(ph)}"]`);
    if (aria && type) cands.push(`${tag}[aria-label="${cssEscapeSafe(aria)}"][type="${cssEscapeSafe(type)}"]`);

    cands.push(buildNthOfTypeSelector(el));

    const unique = [];
    for (const sel of cands) {
      if (!sel || unique.some(x => x.selector === sel)) continue;
      unique.push({ selector: sel, unique: uniqueSelectorTest(sel, el) });
    }

    unique.sort((a, b) => {
      if (a.unique !== b.unique) return a.unique ? -1 : 1;
      return a.selector.length - b.selector.length;
    });

    return unique.slice(0, 8);
  }

  function ensureHighlighter() {
    if (byId('zga-selector-highlight')) return;
    const hl = document.createElement('div');
    hl.id = 'zga-selector-highlight';
    hl.style.cssText = `
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      border: 2px solid #0077ff;
      background: rgba(0,119,255,.08);
      border-radius: 6px;
      display: none;
    `;
    document.body.appendChild(hl);
  }

  function highlightElement(el) {
    ensureHighlighter();
    const hl = byId('zga-selector-highlight');
    if (!el || !visible(el)) {
      hl.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = `${r.left}px`;
    hl.style.top = `${r.top}px`;
    hl.style.width = `${r.width}px`;
    hl.style.height = `${r.height}px`;
  }

  function renderSelectorInfo(info) {
    const box = byId('zga-selector-debug-output');
    if (!box) return;

    if (!info) {
      box.innerHTML = '<div class="zga-small">Noch kein Element gewählt.</div>';
      return;
    }

    const rows = info.selectors.map((x, idx) => `
      <div class="zga-sel-row">
        <div class="zga-sel-meta">${idx === 0 ? 'Top' : 'Alt'} ${x.unique ? '· eindeutig' : '· nicht eindeutig'}</div>
        <code>${escapeHtml(x.selector)}</code>
        <button type="button" data-copy-selector="${idx}">Kopieren</button>
      </div>
    `).join('');

    box.innerHTML = `
      <div class="zga-small"><strong>Element:</strong> ${escapeHtml(info.tag)}</div>
      <div class="zga-small">${escapeHtml(info.desc)}</div>
      <div class="zga-small">Text: ${escapeHtml(info.textSnippet)}</div>
      <div class="zga-sel-list">${rows}</div>
    `;

    box.querySelectorAll('[data-copy-selector]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-copy-selector'));
        const sel = info.selectors[idx]?.selector;
        if (!sel) return;
        navigator.clipboard.writeText(sel).then(() => flash('Selector kopiert.', 'ok'));
      });
    });
  }

  function inspectElement(el) {
    if (!el) return;
    const info = {
      tag: el.tagName.toLowerCase(),
      desc: describeElement(el),
      textSnippet: normalizeText(el.innerText || el.textContent || '').slice(0, 120) || '<kein sichtbarer Text>',
      selectors: buildCandidateSelectors(el)
    };
    state.lastSelectorInfo = info;
    renderSelectorInfo(info);
    highlightElement(el);
  }

  function onDebugMouseMove(ev) {
    if (!state.selectorDebugActive) return;
    const el = ev.target;
    if (!el || el.closest('#zero-grid-assistant')) return;
    state.hoverTarget = el;
    highlightElement(el);
  }

  function onDebugClick(ev) {
    if (!state.selectorDebugActive) return;
    const el = ev.target;
    if (!el || el.closest('#zero-grid-assistant')) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    inspectElement(el);
  }

  function setSelectorDebug(active) {
    state.selectorDebugActive = active;
    const btn = byId('zga-selector-debug-toggle');
    if (btn) btn.textContent = active ? 'Selector-Debugger beenden' : 'Selector-Debugger starten';
    if (!active) highlightElement(null);
    flash(active ? 'Selector-Debugger aktiv: Klicke auf ein Element.' : 'Selector-Debugger beendet.', 'ok');
  }

  function updateOrderUrls() {
    try {
      state.lastBuyUrl = computeOrder('buy').url;
      state.lastSellUrl = computeOrder('sell').url;
    } catch (_) {
      state.lastBuyUrl = '';
      state.lastSellUrl = '';
    }
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'zero-grid-assistant';
    panel.innerHTML = `
      <div class="zga-header">
        <strong>ZERO Grid Assistant v0.6</strong>
        <button id="zga-toggle" type="button">${state.panelOpen ? '–' : '+'}</button>
      </div>

      <div class="zga-body" ${state.panelOpen ? '' : 'hidden'}>
        <label>ISIN
          <input id="zga-symbol" type="text" value="${escapeHtml(state.symbol)}" placeholder="z.B. US0079031078">
        </label>

        <div class="zga-cols">
          <label>Anchor
            <input id="zga-anchor" type="number" step="0.01" value="${state.anchor}">
          </label>
          <label>Abstand
            <input id="zga-step" type="number" step="0.01" value="${state.step}">
          </label>
        </div>

        <div class="zga-cols">
          <label>Basis-Menge
            <input id="zga-qty" type="number" step="1" min="1" value="${state.qty}">
          </label>
          <label>Bestand Override
            <input id="zga-manual-available" type="number" step="0.0001" min="0" placeholder="optional">
          </label>
        </div>

        <label>Letzter Kurs
          <input id="zga-last" type="number" step="0.01" placeholder="optional">
        </label>

        <div class="zga-grid">
          <div>Kauf-Limit</div><div id="zga-buy">-</div>
          <div>Verkauf-Limit</div><div id="zga-sell">-</div>
          <div>Nächster Kauf</div><div id="zga-next-buy">-</div>
          <div>Nächster Verkauf</div><div id="zga-next-sell">-</div>
          <div>Kauf min. Menge</div><div id="zga-buy-minqty">-</div>
          <div>Verkauf min. Menge</div><div id="zga-sell-minqty">-</div>
          <div>Auto-Bestand</div><div id="zga-auto-available">-</div>
          <div>Effektiver Bestand</div><div id="zga-effective-available">-</div>
        </div>

        <div class="zga-status">
          <div><strong>Bestands-Scan:</strong> <span id="zga-holding-scan-status">-</span></div>
          <div id="zga-hint">Nur Vorbelegung. Kein Auto-Submit.</div>
        </div>

        <div class="zga-actions">
          <button id="zga-read-holding" type="button">Bestand lesen</button>
          <button id="zga-copy-plan" type="button">Ablauf kopieren</button>
          <button id="zga-open-buy" type="button">Kauf-Link öffnen</button>
          <button id="zga-open-sell" type="button">Verkauf-Link öffnen</button>
          <button id="zga-copy-buy" type="button">Kauf-URL kopieren</button>
          <button id="zga-copy-sell" type="button">Verkauf-URL kopieren</button>
          <button id="zga-selector-debug-toggle" type="button">Selector-Debugger starten</button>
        </div>

        <div class="zga-debug-box">
          <div class="zga-debug-head">Kauf-URL</div>
          <code id="zga-buy-url"></code>
          <div class="zga-debug-head" style="margin-top:10px;">Verkauf-URL</div>
          <code id="zga-sell-url"></code>
        </div>

        <div class="zga-debug-box">
          <div class="zga-debug-head">Selector-Debugger</div>
          <div id="zga-selector-debug-output">
            <div class="zga-small">Noch kein Element gewählt.</div>
          </div>
        </div>

        <div id="zga-flash" class="zga-flash" hidden></div>
      </div>
    `;
    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #zero-grid-assistant {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        width: 440px;
        max-width: calc(100vw - 24px);
        background: #fff;
        color: #111;
        border: 1px solid #cfcfcf;
        border-radius: 14px;
        box-shadow: 0 14px 40px rgba(0,0,0,.18);
        font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      #zero-grid-assistant * { box-sizing: border-box; }
      #zero-grid-assistant .zga-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 12px;
        border-bottom: 1px solid #ececec;
        background: #fafafa;
        border-radius: 14px 14px 0 0;
      }
      #zero-grid-assistant .zga-body {
        display: grid;
        gap: 10px;
        padding: 12px;
      }
      #zero-grid-assistant .zga-cols {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zero-grid-assistant label {
        display: grid;
        gap: 4px;
        font-size: 12px;
        color: #444;
      }
      #zero-grid-assistant input {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #bfbfbf;
        border-radius: 8px;
        background: #fff;
        color: #111;
      }
      #zero-grid-assistant .zga-grid {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px 10px;
        padding: 10px;
        background: #f7f7f7;
        border-radius: 10px;
      }
      #zero-grid-assistant .zga-status,
      #zero-grid-assistant .zga-debug-box {
        padding: 10px;
        background: #fbfbfb;
        border: 1px solid #ececec;
        border-radius: 10px;
      }
      #zero-grid-assistant .zga-debug-head {
        font-weight: 600;
        margin-bottom: 8px;
      }
      #zero-grid-assistant .zga-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zero-grid-assistant .zga-actions button:last-child {
        grid-column: 1 / -1;
      }
      #zero-grid-assistant button {
        padding: 9px 10px;
        border: 1px solid #bdbdbd;
        border-radius: 8px;
        background: #fafafa;
        color: #111;
        cursor: pointer;
      }
      #zero-grid-assistant button:hover { background: #f0f0f0; }
      #zero-grid-assistant code {
        display: block;
        white-space: pre-wrap;
        word-break: break-all;
        font-size: 12px;
        background: #f5f5f5;
        padding: 8px;
        border-radius: 8px;
      }
      #zero-grid-assistant .zga-flash {
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid transparent;
      }
      #zero-grid-assistant .zga-flash[data-type="ok"] {
        background: #eef6ff;
        border-color: #c9dfff;
        color: #184a7a;
      }
      #zero-grid-assistant .zga-flash[data-type="warn"] {
        background: #fff8e8;
        border-color: #f0dca6;
        color: #7a5810;
      }
      #zero-grid-assistant .zga-flash[data-type="error"] {
        background: #fff1f1;
        border-color: #efc4c4;
        color: #8a1f1f;
      }
      #zero-grid-assistant .zga-small {
        font-size: 12px;
        color: #555;
        margin: 4px 0 0;
      }
      #zero-grid-assistant .zga-sel-list {
        display: grid;
        gap: 8px;
        margin-top: 8px;
      }
      #zero-grid-assistant .zga-sel-row {
        display: grid;
        gap: 4px;
        padding: 8px;
        background: #fff;
        border: 1px solid #ececec;
        border-radius: 8px;
      }
      #zero-grid-assistant .zga-sel-meta {
        font-size: 11px;
        color: #666;
      }
    `;
    document.head.appendChild(style);
  }

  function updateView() {
    const g = grid(state.anchor, state.step);
    const buyQty = requiredBuyQty(g.buy);
    const sellQty = requiredSellQty(g.sell);
    const sellCheck = canSellAt500(g.sell);
    const effectiveAvailable = getEffectiveAvailableQty();

    updateOrderUrls();

    byId('zga-buy').textContent = fmt.format(g.buy);
    byId('zga-sell').textContent = fmt.format(g.sell);
    byId('zga-next-buy').textContent = fmt.format(g.nextBuyAfterSell);
    byId('zga-next-sell').textContent = fmt.format(g.nextSellAfterSell);
    byId('zga-buy-minqty').textContent = `${buyQty} Stk (${fmt.format(round2(g.buy * buyQty))})`;
    byId('zga-sell-minqty').textContent = `${sellQty} Stk (${fmt.format(round2(g.sell * sellQty))})`;
    byId('zga-auto-available').textContent = state.autoAvailableQty == null ? '—' : `${state.autoAvailableQty} Stk`;
    byId('zga-effective-available').textContent = effectiveAvailable == null ? '—' : `${effectiveAvailable} Stk`;
    byId('zga-holding-scan-status').textContent = state.lastHoldingScan;
    byId('zga-buy-url').textContent = state.lastBuyUrl || '—';
    byId('zga-sell-url').textContent = state.lastSellUrl || '—';

    const hints = [];
    if (state.lastPrice != null && !Number.isNaN(state.lastPrice)) {
      if (state.lastPrice >= g.sell) hints.push(`Verkaufsschwelle erreicht: ${fmt.format(state.lastPrice)} >= ${fmt.format(g.sell)}.`);
      else if (state.lastPrice <= g.buy) hints.push(`Kaufschwelle erreicht: ${fmt.format(state.lastPrice)} <= ${fmt.format(g.buy)}.`);
      else hints.push(`Im Korridor: ${fmt.format(g.buy)} bis ${fmt.format(g.sell)}.`);
    } else {
      hints.push('Kein letzter Kurs gesetzt.');
    }

    hints.push(`Kauf immer >= ${fmt.format(CONFIG.minNotional)} mit mindestens ${buyQty} Stk.`);

    if (effectiveAvailable != null) {
      hints.push(
        sellCheck.ok
          ? `Verkauf möglich: Bestand ${effectiveAvailable} Stk reicht für mindestens ${sellQty} Stk.`
          : `Verkauf blockiert: Bestand ${effectiveAvailable} Stk kleiner als nötig (${sellQty} Stk).`
      );
    } else {
      hints.push(`Bestand unbekannt. Für Verkauf wären mindestens ${sellQty} Stk nötig.`);
    }

    hints.push(state.selectorDebugActive ? 'Selector-Debugger aktiv.' : 'URL-Modus aktiv. Kein Auto-Submit.');
    byId('zga-hint').textContent = hints.join(' ');
  }

  function bindPanel() {
    byId('zga-toggle').addEventListener('click', () => {
      state.panelOpen = !state.panelOpen;
      byId('zero-grid-assistant').querySelector('.zga-body').hidden = !state.panelOpen;
      byId('zga-toggle').textContent = state.panelOpen ? '–' : '+';
    });

    byId('zga-symbol').addEventListener('input', e => {
      state.symbol = e.target.value.trim();
      updateView();
      if (CONFIG.autoReadHolding) {
        clearTimeout(bindPanel._holdingTimer);
        bindPanel._holdingTimer = setTimeout(readAvailableQtyAuto, 400);
      }
    });

    byId('zga-anchor').addEventListener('input', e => { state.anchor = Number(e.target.value || 0); updateView(); });
    byId('zga-step').addEventListener('input', e => { state.step = Number(e.target.value || 0); updateView(); });
    byId('zga-qty').addEventListener('input', e => { state.qty = Number(e.target.value || 0); updateView(); });
    byId('zga-manual-available').addEventListener('input', e => { state.manualAvailableQty = e.target.value; updateView(); });
    byId('zga-last').addEventListener('input', e => {
      state.lastPrice = e.target.value === '' ? null : Number(e.target.value);
      updateView();
    });

    byId('zga-read-holding').addEventListener('click', readAvailableQtyAuto);
    byId('zga-open-buy').addEventListener('click', () => openPreparedOrder('buy'));
    byId('zga-open-sell').addEventListener('click', () => openPreparedOrder('sell'));
    byId('zga-copy-buy').addEventListener('click', () => copyOrderUrl('buy'));
    byId('zga-copy-sell').addEventListener('click', () => copyOrderUrl('sell'));
    byId('zga-copy-plan').addEventListener('click', copyPlan);

    byId('zga-selector-debug-toggle').addEventListener('click', () => {
      setSelectorDebug(!state.selectorDebugActive);
      updateView();
    });
  }

  function setupDebugListeners() {
    document.addEventListener('mousemove', onDebugMouseMove, true);
    document.addEventListener('click', onDebugClick, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && state.selectorDebugActive) {
        setSelectorDebug(false);
        updateView();
      }
    }, true);
  }

  function setupObservers() {
    if (CONFIG.autoReadHolding) {
      const mo = new MutationObserver(() => {
        clearTimeout(setupObservers._t);
        setupObservers._t = setTimeout(readAvailableQtyAuto, 700);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function init() {
    if (byId('zero-grid-assistant')) return;
    buildPanel();
    bindPanel();
    setupDebugListeners();
    updateView();
    setupObservers();
    setTimeout(readAvailableQtyAuto, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
