// ==UserScript==
// @name         ZERO Grid Assistant v0.3
// @namespace    local.zero.grid.assistant
// @version      0.3.0
// @description  Assistives Grid-Overlay mit 500€-Mindestvolumen, Bestandsprüfung für Verkauf, ohne Auto-Submit
// @match        https://mein.finanzen-zero.net/*
// @match        https://*.finanzen-zero.net/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    minNotional: 500,
    preferGermanDecimal: true,
    autoScan: true,
    symbol: 'ETF',
    anchor: 100.00,
    step: 0.50,
    qty: 1,
    availableQty: '',
    selectors: {
      orderModal: [
        '[data-testid*="order"]',
        '[data-testid*="Order"]',
        '[class*="order"]',
        '[class*="Order"]',
        'form',
        '[role="dialog"]'
      ],
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
      buySellTabs: {
        buy: [
          '[data-testid*="buy"]',
          '[data-testid*="Buy"]',
          'button[aria-label*="Kauf"]',
          'button[aria-label*="Buy"]',
          'button'
        ],
        sell: [
          '[data-testid*="sell"]',
          '[data-testid*="Sell"]',
          'button[aria-label*="Verkauf"]',
          'button[aria-label*="Sell"]',
          'button'
        ]
      }
    }
  };

  const state = {
    symbol: CONFIG.symbol,
    anchor: CONFIG.anchor,
    step: CONFIG.step,
    qty: CONFIG.qty,
    availableQty: CONFIG.availableQty,
    lastPrice: null,
    panelOpen: true,
    lastScanResult: 'Noch nicht gesucht',
    formRef: null
  };

  const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

  function round2(v) {
    return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  }

  function isFiniteNumber(v) {
    return Number.isFinite(Number(v));
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

  function parseAvailableQty() {
    if (state.availableQty === '' || state.availableQty == null) return null;
    const v = Number(state.availableQty);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }

  function requiredBuyQty(price) {
    return Math.max(Number(state.qty || 0), minQtyForNotional(price));
  }

  function requiredSellQty(price) {
    return Math.max(Number(state.qty || 0), minQtyForNotional(price));
  }

  function canSellAt500(price) {
    const required = requiredSellQty(price);
    const available = parseAvailableQty();
    if (available == null) return { ok: true, required, available: null };
    return { ok: available >= required, required, available };
  }

  function numberToInputString(v) {
    const s = round2(v).toFixed(2);
    return CONFIG.preferGermanDecimal ? s.replace('.', ',') : s;
  }

  function setNativeValue(el, value) {
    const prototype = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (desc && desc.set) desc.set.call(el, value);
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

  function findByText(candidates, needles) {
    for (const needle of needles) {
      const low = needle.toLowerCase();
      const match = candidates.find(el => {
        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
        return txt.includes(low);
      });
      if (match) return match;
    }
    return null;
  }

  function findOrderForm() {
    const candidates = qsa(CONFIG.selectors.orderModal).filter(visible);
    if (!candidates.length) return null;
    for (const c of candidates) {
      const inputs = [...c.querySelectorAll('input')].filter(visible);
      if (inputs.length >= 2) return c;
    }
    return candidates[0] || null;
  }

  function findField(root, selectorList, labelWords) {
    const direct = qsa(selectorList, root).filter(visible);
    if (direct.length) return direct[0];

    const allInputs = [...root.querySelectorAll('input')].filter(visible);
    for (const input of allInputs) {
      const id = input.id;
      const lbl = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) || document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const hay = [
        input.getAttribute('name') || '',
        input.getAttribute('placeholder') || '',
        input.getAttribute('aria-label') || '',
        lbl ? (lbl.innerText || lbl.textContent || '') : ''
      ].join(' ').toLowerCase();

      if (labelWords.some(w => hay.includes(w))) return input;
    }
    return null;
  }

  function findActionTab(root, side) {
    const selectors = side === 'buy' ? CONFIG.selectors.buySellTabs.buy : CONFIG.selectors.buySellTabs.sell;
    const candidates = qsa(selectors, root).filter(visible);
    return findByText(candidates, side === 'buy' ? ['kauf', 'buy'] : ['verkauf', 'sell']);
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
      `Maske erkannt | Preis: ${!!priceInput} | Menge: ${!!qtyInput} | Kauf: ${!!buyTab} | Verkauf: ${!!sellTab}`;
    updateView();
    return state.formRef;
  }

  function ensureFormRef() {
    return state.formRef || scanForm();
  }

  function fillOrder(side) {
    const ref = ensureFormRef();
    if (!ref || !ref.form) {
      flash('Keine Ordermaske gefunden.', 'warn');
      return;
    }

    const g = grid(state.anchor, state.step);
    const price = side === 'buy' ? g.buy : g.sell;
    let qty = side === 'buy' ? requiredBuyQty(price) : requiredSellQty(price);

    if (side === 'sell') {
      const sellCheck = canSellAt500(price);
      if (!sellCheck.ok) {
        flash(
          `Verkauf blockiert: Für ${fmt.format(CONFIG.minNotional)} bei ${fmt.format(price)} brauchst du ${sellCheck.required} Stk, verfügbar sind nur ${sellCheck.available} Stk.`,
          'error'
        );
        return;
      }
    }

    const notional = round2(price * qty);

    if (side === 'buy' && ref.buyTab) ref.buyTab.click();
    if (side === 'sell' && ref.sellTab) ref.sellTab.click();

    if (ref.priceInput) {
      ref.priceInput.focus();
      setNativeValue(ref.priceInput, numberToInputString(price));
    }

    if (ref.qtyInput) {
      ref.qtyInput.focus();
      setNativeValue(ref.qtyInput, String(qty));
    }

    flash(
      `${side === 'buy' ? 'Kauf' : 'Verkauf'} vorbereitet: ${numberToInputString(price)} × ${qty} = ${fmt.format(notional)}`,
      'ok'
    );
    updatePreparedHint(side, price, qty, notional);
  }

  function updatePreparedHint(side, price, qty, notional) {
    const el = byId('zga-hint');
    if (!el) return;
    el.textContent =
      `${side === 'buy' ? 'Kauf' : 'Verkauf'} vorbereitet: Preis ${fmt.format(price)}, Menge ${qty}, Volumen ${fmt.format(notional)}. Mindestziel ${fmt.format(CONFIG.minNotional)} erfüllt.`;
  }

  function copyPlan() {
    const g = grid(state.anchor, state.step);
    const buyQty = requiredBuyQty(g.buy);
    const sellQty = requiredSellQty(g.sell);
    const sellCheck = canSellAt500(g.sell);

    const text =
`Symbol: ${state.symbol}
Anchor: ${state.anchor.toFixed(2)}
Abstand: ${state.step.toFixed(2)}

Kauf:
- Preis: ${g.buy.toFixed(2)}
- Mindestmenge für >= ${CONFIG.minNotional} €: ${buyQty}
- Volumen: ${(g.buy * buyQty).toFixed(2)} €

Verkauf:
- Preis: ${g.sell.toFixed(2)}
- Mindestmenge für >= ${CONFIG.minNotional} €: ${sellQty}
- Volumen: ${(g.sell * sellQty).toFixed(2)} €
- Bestand ausreichend: ${sellCheck.ok ? 'ja' : 'nein'}

Nach Verkauf bei ${g.sell.toFixed(2)}:
- Alte Kauforder ${g.buy.toFixed(2)} manuell prüfen/löschen
- Neue Kauforder ${g.nextBuyAfterSell.toFixed(2)} vorbereiten
- Neue Verkaufsorder ${g.nextSellAfterSell.toFixed(2)} vorbereiten

Hinweis:
- Kein Auto-Submit
- Finale Prüfung und Freigabe immer manuell`;

    navigator.clipboard.writeText(text).then(() => flash('Ablauf kopiert.', 'ok'));
  }

  function flash(msg, type = 'ok') {
    const el = byId('zga-flash');
    if (!el) return;
    el.textContent = msg;
    el.dataset.type = type;
    el.hidden = false;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'zero-grid-assistant';
    panel.innerHTML = `
      <div class="zga-header">
        <strong>ZERO Grid Assistant v0.3</strong>
        <button id="zga-toggle" type="button" title="Ein-/Ausklappen">${state.panelOpen ? '–' : '+'}</button>
      </div>
      <div class="zga-body" ${state.panelOpen ? '' : 'hidden'}>
        <label>Symbol
          <input id="zga-symbol" type="text" value="${escapeHtml(state.symbol)}">
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
          <label>Verfügbarer Bestand
            <input id="zga-available" type="number" step="1" min="0" placeholder="optional">
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
        </div>

        <div class="zga-status">
          <div><strong>Scan:</strong> <span id="zga-scan-status">-</span></div>
          <div id="zga-hint">Nur Vorbelegung. Kein Auto-Submit.</div>
        </div>

        <div class="zga-actions">
          <button id="zga-scan" type="button">Maske suchen</button>
          <button id="zga-copy-plan" type="button">Ablauf kopieren</button>
          <button id="zga-apply-buy" type="button">Kauf vorbefüllen</button>
          <button id="zga-apply-sell" type="button">Verkauf vorbefüllen</button>
          <button id="zga-copy-buy" type="button">Kaufpreis kopieren</button>
          <button id="zga-copy-sell" type="button">Verkaufspreis kopieren</button>
        </div>

        <div id="zga-flash" class="zga-flash" hidden></div>

        <details>
          <summary>Hinweise</summary>
          <p class="zga-small">
            Verkauf wird blockiert, wenn der eingetragene verfügbare Bestand kleiner ist als die
            Mindestmenge für ein Volumen von mindestens ${CONFIG.minNotional} €.
          </p>
          <p class="zga-small">
            Falls ZERO die Oberfläche ändert, ergänze oben passende Selektoren in CONFIG.selectors.
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
        width: 380px;
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
    const buyMinQty = minQtyForNotional(g.buy);
    const sellMinQty = minQtyForNotional(g.sell);
    const buyQty = requiredBuyQty(g.buy);
    const sellQty = requiredSellQty(g.sell);
    const sellCheck = canSellAt500(g.sell);

    byId('zga-buy').textContent = fmt.format(g.buy);
    byId('zga-sell').textContent = fmt.format(g.sell);
    byId('zga-next-buy').textContent = fmt.format(g.nextBuyAfterSell);
    byId('zga-next-sell').textContent = fmt.format(g.nextSellAfterSell);
    byId('zga-buy-minqty').textContent = `${buyQty} Stk (${fmt.format(round2(g.buy * buyQty))})`;
    byId('zga-sell-minqty').textContent =
      `${sellQty} Stk (${fmt.format(round2(g.sell * sellQty))})${sellCheck.ok ? '' : ' — Bestand zu klein'}`;
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

    hints.push(`Kauf immer >= ${fmt.format(CONFIG.minNotional)} mit mindestens ${buyMinQty} Stk.`);
    if (sellCheck.available != null) {
      hints.push(
        sellCheck.ok
          ? `Verkauf möglich: Bestand ${sellCheck.available} Stk reicht für mindestens ${sellMinQty} Stk.`
          : `Verkauf blockiert: Bestand ${sellCheck.available} Stk kleiner als nötig (${sellMinQty} Stk).`
      );
    } else {
      hints.push(`Für Verkauf sind mindestens ${sellMinQty} Stk nötig, falls ebenfalls >= ${fmt.format(CONFIG.minNotional)} erreicht werden soll.`);
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
    byId('zga-available').addEventListener('input', e => { state.availableQty = e.target.value; updateView(); });
    byId('zga-last').addEventListener('input', e => {
      state.lastPrice = e.target.value === '' ? null : Number(e.target.value);
      updateView();
    });

    byId('zga-scan').addEventListener('click', () => scanForm());
    byId('zga-apply-buy').addEventListener('click', () => fillOrder('buy'));
    byId('zga-apply-sell').addEventListener('click', () => fillOrder('sell'));

    byId('zga-copy-buy').addEventListener('click', () => {
      const g = grid(state.anchor, state.step);
      navigator.clipboard.writeText(g.buy.toFixed(2)).then(() => flash('Kaufpreis kopiert.', 'ok'));
    });

    byId('zga-copy-sell').addEventListener('click', () => {
      const g = grid(state.anchor, state.step);
      navigator.clipboard.writeText(g.sell.toFixed(2)).then(() => flash('Verkaufspreis kopiert.', 'ok'));
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
