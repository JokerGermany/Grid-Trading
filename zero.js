// ==UserScript==
// @name         ZERO Grid Assistant v0.2
// @namespace    local.zero.grid.assistant
// @version      0.2.0
// @description  Assistives Grid-Overlay mit heuristischer Ordermasken-Erkennung, ohne Auto-Submit
// @match        https://mein.finanzen-zero.net/*
// @match        https://*.finanzen-zero.net/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    symbol: 'ETF',
    anchor: 100.00,
    step: 0.50,
    qty: 1,
    autoScan: true,
    preferGermanDecimal: true,

    selectors: {
      orderModal: [
        '[data-testid*="order"]',
        '[class*="order"]',
        '[class*="Order"]',
        'form',
        '[role="dialog"]'
      ],
      buySellTabs: {
        buy: [
          '[data-testid*="buy"]',
          'button[aria-label*="Kauf"]',
          'button[aria-label*="Buy"]',
          'button'
        ],
        sell: [
          '[data-testid*="sell"]',
          'button[aria-label*="Verkauf"]',
          'button[aria-label*="Sell"]',
          'button'
        ]
      },
      priceInput: [
        'input[name*="price" i]',
        'input[name*="limit" i]',
        'input[placeholder*="Preis" i]',
        'input[aria-label*="Preis" i]',
        'input[inputmode="decimal"]'
      ],
      qtyInput: [
        'input[name*="qty" i]',
        'input[name*="quantity" i]',
        'input[name*="stück" i]',
        'input[placeholder*="Stück" i]',
        'input[aria-label*="Stück" i]',
        'input[inputmode="numeric"]'
      ],
      summaryBox: [
        '[data-testid*="summary"]',
        '[class*="summary"]',
        '[class*="Summary"]'
      ]
    }
  };

  const state = {
    symbol: CONFIG.symbol,
    anchor: CONFIG.anchor,
    step: CONFIG.step,
    qty: CONFIG.qty,
    lastPrice: null,
    panelOpen: true,
    lastScanResult: 'Noch nicht gesucht',
    formRef: null
  };

  const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

  function round2(v) {
    return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
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

  function numberToInputString(v) {
    const s = round2(v).toFixed(2);
    return CONFIG.preferGermanDecimal ? s.replace('.', ',') : s;
  }

  function setNativeValue(el, value) {
    const descriptor = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
    const setter = descriptor && descriptor.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
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

  function findByText(candidates, wanted) {
    const low = wanted.toLowerCase();
    return candidates.find(el => {
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      return txt && txt.includes(low);
    });
  }

  function findOrderForm() {
    const forms = qsa(CONFIG.selectors.orderModal).filter(visible);
    if (!forms.length) return null;

    for (const candidate of forms) {
      const inputs = candidate.querySelectorAll('input');
      if (inputs.length >= 2) return candidate;
    }
    return forms[0] || null;
  }

  function findField(root, selectorList, labelWords = []) {
    const direct = qsa(selectorList, root).filter(visible);
    if (direct.length) return direct[0];

    const allInputs = [...root.querySelectorAll('input')].filter(visible);
    for (const input of allInputs) {
      const id = input.id;
      const aria = (input.getAttribute('aria-label') || '').toLowerCase();
      const ph = (input.getAttribute('placeholder') || '').toLowerCase();
      const nm = (input.getAttribute('name') || '').toLowerCase();
      const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const lblText = (lbl?.innerText || '').toLowerCase();
      const hay = `${aria} ${ph} ${nm} ${lblText}`;
      if (labelWords.some(w => hay.includes(w))) return input;
    }
    return null;
  }

  function findActionTab(root, side) {
    const selectors = side === 'buy'
      ? CONFIG.selectors.buySellTabs.buy
      : CONFIG.selectors.buySellTabs.sell;

    const candidates = qsa(selectors, root).filter(visible);
    const textNeedles = side === 'buy'
      ? ['kauf', 'buy']
      : ['verkauf', 'sell'];

    for (const needle of textNeedles) {
      const found = findByText(candidates, needle);
      if (found) return found;
    }
    return null;
  }

  function scanForm() {
    const form = findOrderForm();
    if (!form) {
      state.formRef = null;
      state.lastScanResult = 'Keine Ordermaske erkannt';
      updateView();
      return null;
    }

    const priceInput = findField(form, CONFIG.selectors.priceInput, ['preis', 'price', 'limit']);
    const qtyInput = findField(form, CONFIG.selectors.qtyInput, ['stück', 'qty', 'quantity', 'anzahl']);
    const buyTab = findActionTab(form, 'buy');
    const sellTab = findActionTab(form, 'sell');

    state.formRef = { form, priceInput, qtyInput, buyTab, sellTab };
    state.lastScanResult =
      `Maske erkannt | Preis: ${!!priceInput} | Menge: ${!!qtyInput} | Kauf-Tab: ${!!buyTab} | Verkauf-Tab: ${!!sellTab}`;
    updateView();
    return state.formRef;
  }

  function ensureFormRef() {
    return state.formRef || scanForm();
  }

  function applySide(side) {
    const ref = ensureFormRef();
    if (!ref || !ref.form) {
      flash('Keine Ordermaske gefunden.');
      return;
    }

    const g = grid(state.anchor, state.step);
    const price = side === 'buy' ? g.buy : g.sell;

    if (side === 'buy' && ref.buyTab) ref.buyTab.click();
    if (side === 'sell' && ref.sellTab) ref.sellTab.click();

    if (ref.priceInput) {
      ref.priceInput.focus();
      setNativeValue(ref.priceInput, numberToInputString(price));
    }
    if (ref.qtyInput) {
      ref.qtyInput.focus();
      setNativeValue(ref.qtyInput, String(state.qty));
    }

    flash(`${side === 'buy' ? 'Kauf' : 'Verkauf'} vorbereitet: ${numberToInputString(price)} / Menge ${state.qty}`);
    updateView();
  }

  function copyPlan() {
    const g = grid(state.anchor, state.step);
    const text =
`Symbol: ${state.symbol}
Anchor: ${state.anchor.toFixed(2)}
Abstand: ${state.step.toFixed(2)}
Menge: ${state.qty}

Aktuelle Kauforder: ${g.buy.toFixed(2)}
Aktuelle Verkaufsorder: ${g.sell.toFixed(2)}

Nach Verkauf bei ${g.sell.toFixed(2)}:
- Alte Kauforder ${g.buy.toFixed(2)} manuell prüfen/löschen
- Neue Kauforder ${g.nextBuyAfterSell.toFixed(2)} vorbereiten
- Neue Verkaufsorder ${g.nextSellAfterSell.toFixed(2)} vorbereiten

Hinweis:
- Dieses Skript sendet keine Orders ab.
- Vor dem finalen Absenden Werte in der Ordermaske prüfen.`;
    navigator.clipboard.writeText(text).then(() => flash('Ablauf kopiert.'));
  }

  function flash(msg) {
    const el = byId('zga-flash');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { el.hidden = true; }, 2200);
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'zero-grid-assistant';
    panel.innerHTML = `
      <div class="zga-header">
        <strong>ZERO Grid Assistant v0.2</strong>
        <button id="zga-toggle" type="button" title="Ein-/Ausklappen">${state.panelOpen ? '–' : '+'}</button>
      </div>
      <div class="zga-body" ${state.panelOpen ? '' : 'hidden'}>
        <label>Symbol<input id="zga-symbol" type="text" value="${escapeHtml(state.symbol)}"></label>
        <label>Anchor<input id="zga-anchor" type="number" step="0.01" value="${state.anchor}"></label>
        <label>Abstand<input id="zga-step" type="number" step="0.01" value="${state.step}"></label>
        <label>Menge<input id="zga-qty" type="number" step="1" value="${state.qty}"></label>
        <label>Letzter Kurs<input id="zga-last" type="number" step="0.01" placeholder="optional"></label>

        <div class="zga-grid">
          <div>Kauf-Limit</div><div id="zga-buy">-</div>
          <div>Verkauf-Limit</div><div id="zga-sell">-</div>
          <div>Nächster Kauf nach Verkauf</div><div id="zga-next-buy">-</div>
          <div>Nächster Verkauf nach Verkauf</div><div id="zga-next-sell">-</div>
        </div>

        <div class="zga-status">
          <div><strong>Scan:</strong> <span id="zga-scan-status">-</span></div>
          <div id="zga-hint">Nur Vorbelegung. Kein Auto-Submit.</div>
        </div>

        <div class="zga-actions">
          <button id="zga-scan" type="button">Maske suchen</button>
          <button id="zga-apply-buy" type="button">Kauf vorbefüllen</button>
          <button id="zga-apply-sell" type="button">Verkauf vorbefüllen</button>
          <button id="zga-copy-buy" type="button">Kaufpreis kopieren</button>
          <button id="zga-copy-sell" type="button">Verkaufspreis kopieren</button>
          <button id="zga-copy-plan" type="button">Ablauf kopieren</button>
        </div>

        <div id="zga-flash" class="zga-flash" hidden></div>

        <details>
          <summary>Selektoren anpassen</summary>
          <p class="zga-small">
            Falls ZERO die Oberfläche ändert, prüfe Preis- und Mengenfeld per Browser-DevTools
            und ergänze die Arrays in CONFIG.selectors.
          </p>
        </details>
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
        width: 360px;
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
      #zero-grid-assistant .zga-status {
        padding: 10px;
        background: #fbfbfb;
        border: 1px solid #ececec;
        border-radius: 10px;
      }
      #zero-grid-assistant .zga-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zero-grid-assistant button {
        padding: 9px 10px;
        border: 1px solid #bdbdbd;
        border-radius: 8px;
        background: #fafafa;
        color: #111;
        cursor: pointer;
      }
      #zero-grid-assistant button:hover {
        background: #f0f0f0;
      }
      #zero-grid-assistant .zga-flash {
        padding: 8px 10px;
        border-radius: 8px;
        background: #eef6ff;
        border: 1px solid #c9dfff;
        color: #184a7a;
      }
      #zero-grid-assistant .zga-small {
        font-size: 12px;
        color: #555;
        margin: 8px 0 0;
      }
      #zero-grid-assistant details summary {
        cursor: pointer;
        user-select: none;
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function updateView() {
    const g = grid(state.anchor, state.step);
    byId('zga-buy').textContent = fmt.format(g.buy);
    byId('zga-sell').textContent = fmt.format(g.sell);
    byId('zga-next-buy').textContent = fmt.format(g.nextBuyAfterSell);
    byId('zga-next-sell').textContent = fmt.format(g.nextSellAfterSell);
    byId('zga-scan-status').textContent = state.lastScanResult;

    const hints = [];
    if (state.lastPrice != null && !Number.isNaN(state.lastPrice)) {
      if (state.lastPrice >= g.sell) {
        hints.push(`Verkaufsschwelle erreicht: ${fmt.format(state.lastPrice)} >= ${fmt.format(g.sell)}.`);
      } else if (state.lastPrice <= g.buy) {
        hints.push(`Kaufschwelle erreicht: ${fmt.format(state.lastPrice)} <= ${fmt.format(g.buy)}.`);
      } else {
        hints.push(`Im Korridor: ${fmt.format(g.buy)} bis ${fmt.format(g.sell)}.`);
      }
    } else {
      hints.push('Kein letzter Kurs gesetzt.');
    }
    hints.push('Nur Vorbelegung. Kein Auto-Submit.');
    byId('zga-hint').textContent = hints.join(' ');
  }

  function bindPanel() {
    byId('zga-toggle').addEventListener('click', () => {
      state.panelOpen = !state.panelOpen;
      byId('zero-grid-assistant').querySelector('.zga-body').hidden = !state.panelOpen;
      byId('zga-toggle').textContent = state.panelOpen ? '–' : '+';
    });

    byId('zga-symbol').addEventListener('input', e => { state.symbol = e.target.value; });
    byId('zga-anchor').addEventListener('input', e => { state.anchor = Number(e.target.value || 0); updateView(); });
    byId('zga-step').addEventListener('input', e => { state.step = Number(e.target.value || 0); updateView(); });
    byId('zga-qty').addEventListener('input', e => { state.qty = Number(e.target.value || 0); updateView(); });
    byId('zga-last').addEventListener('input', e => {
      state.lastPrice = e.target.value === '' ? null : Number(e.target.value);
      updateView();
    });

    byId('zga-scan').addEventListener('click', () => scanForm());
    byId('zga-apply-buy').addEventListener('click', () => applySide('buy'));
    byId('zga-apply-sell').addEventListener('click', () => applySide('sell'));

    byId('zga-copy-buy').addEventListener('click', () => {
      const g = grid(state.anchor, state.step);
      navigator.clipboard.writeText(g.buy.toFixed(2)).then(() => flash('Kaufpreis kopiert.'));
    });

    byId('zga-copy-sell').addEventListener('click', () => {
      const g = grid(state.anchor, state.step);
      navigator.clipboard.writeText(g.sell.toFixed(2)).then(() => flash('Verkaufspreis kopiert.'));
    });

    byId('zga-copy-plan').addEventListener('click', copyPlan);
  }

  function setupObserver() {
    if (!CONFIG.autoScan) return;
    const mo = new MutationObserver(() => {
      const current = findOrderForm();
      if (!current) return;
      if (!state.formRef || state.formRef.form !== current) scanForm();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function init() {
    if (byId('zero-grid-assistant')) return;
    buildPanel();
    bindPanel();
    updateView();
    setupObserver();
    setTimeout(scanForm, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
