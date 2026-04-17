// ==UserScript==
// @name         ZERO Grid Assistant Prototype
// @namespace    local.zero.grid.assistant
// @version      0.1.0
// @description  Assistives Overlay für Grid-Level, ohne Auto-Submit
// @match        https://mein.finanzen-zero.net/*
// @match        https://*.finanzen-zero.net/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const state = {
    symbol: 'ETF',
    anchor: 100.00,
    step: 0.50,
    qty: 1,
    lastPrice: null,
    mode: 'assist',
    panelOpen: true
  };

  const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

  function round2(v) {
    return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  }

  function levels(anchor, step) {
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

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'zero-grid-assistant';
    panel.innerHTML = `
      <div class="zga-header">
        <strong>ZERO Grid Assistant</strong>
        <button id="zga-toggle" type="button">${state.panelOpen ? '–' : '+'}</button>
      </div>
      <div class="zga-body" ${state.panelOpen ? '' : 'hidden'}>
        <label>Symbol<input id="zga-symbol" type="text" value="${state.symbol}"></label>
        <label>Anchor<input id="zga-anchor" type="number" step="0.01" value="${state.anchor}"></label>
        <label>Abstand<input id="zga-step" type="number" step="0.01" value="${state.step}"></label>
        <label>Menge<input id="zga-qty" type="number" step="1" value="${state.qty}"></label>
        <label>Letzter Kurs<input id="zga-last" type="number" step="0.01" placeholder="optional"></label>

        <div class="zga-grid">
          <div>Kauf-Limit</div><div id="zga-buy">-</div>
          <div>Verkauf-Limit</div><div id="zga-sell">-</div>
          <div>Nach Verkauf neuer Anchor</div><div id="zga-next-anchor">-</div>
          <div>Neue Kauforder</div><div id="zga-next-buy">-</div>
          <div>Neue Verkaufsorder</div><div id="zga-next-sell">-</div>
        </div>

        <div class="zga-actions">
          <button id="zga-copy-buy" type="button">Kaufpreis kopieren</button>
          <button id="zga-copy-sell" type="button">Verkaufspreis kopieren</button>
          <button id="zga-copy-plan" type="button">Nächste Schritte kopieren</button>
        </div>

        <div class="zga-note" id="zga-note">
          Nur Anzeige und Kopierhilfe. Kein Auto-Submit.
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #zero-grid-assistant {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 999999;
        width: 340px;
        font: 14px/1.4 system-ui, sans-serif;
        color: #111;
        background: #fff;
        border: 1px solid #ccc;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.18);
      }
      #zero-grid-assistant .zga-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid #eee;
      }
      #zero-grid-assistant .zga-body {
        padding: 12px;
        display: grid;
        gap: 10px;
      }
      #zero-grid-assistant label {
        display: grid;
        gap: 4px;
      }
      #zero-grid-assistant input {
        padding: 8px;
        border: 1px solid #bbb;
        border-radius: 8px;
      }
      #zero-grid-assistant .zga-grid {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px 10px;
        padding: 10px;
        background: #f7f7f7;
        border-radius: 8px;
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
        padding: 8px 10px;
        border: 1px solid #bbb;
        border-radius: 8px;
        background: #fafafa;
        cursor: pointer;
      }
      #zero-grid-assistant .zga-note {
        font-size: 12px;
        color: #555;
      }
    `;
    document.head.appendChild(style);
  }

  function updateView() {
    const l = levels(state.anchor, state.step);
    byId('zga-buy').textContent = fmt.format(l.buy);
    byId('zga-sell').textContent = fmt.format(l.sell);
    byId('zga-next-anchor').textContent = fmt.format(l.nextAnchorAfterSell);
    byId('zga-next-buy').textContent = fmt.format(l.nextBuyAfterSell);
    byId('zga-next-sell').textContent = fmt.format(l.nextSellAfterSell);

    const note = [];
    if (state.lastPrice != null && !Number.isNaN(state.lastPrice)) {
      if (state.lastPrice >= l.sell) {
        note.push(`Signal: Verkaufslimit erreicht (${fmt.format(state.lastPrice)} >= ${fmt.format(l.sell)})`);
        note.push(`Manuell prüfen: alte Kauforder ${fmt.format(l.buy)} löschen, neue Kauforder ${fmt.format(l.nextBuyAfterSell)} anlegen, Verkaufsorder ${fmt.format(l.nextSellAfterSell)} anlegen.`);
      } else if (state.lastPrice <= l.buy) {
        note.push(`Signal: Kauflimit erreicht (${fmt.format(state.lastPrice)} <= ${fmt.format(l.buy)})`);
        note.push(`Manuell prüfen: Position/Bestand und neue Gegenorder kontrollieren.`);
      } else {
        note.push(`Keine Schwelle erreicht. Aktueller Korridor: ${fmt.format(l.buy)} bis ${fmt.format(l.sell)}.`);
      }
    } else {
      note.push('Kein letzter Kurs gesetzt.');
    }
    byId('zga-note').textContent = note.join(' ');
  }

  function bindEvents() {
    byId('zga-toggle').addEventListener('click', () => {
      state.panelOpen = !state.panelOpen;
      byId('zero-grid-assistant').querySelector('.zga-body').hidden = !state.panelOpen;
      byId('zga-toggle').textContent = state.panelOpen ? '–' : '+';
    });

    ['symbol', 'anchor', 'step', 'qty', 'last'].forEach((key) => {
      const id = key === 'last' ? 'zga-last' : `zga-${key}`;
      byId(id).addEventListener('input', (e) => {
        const v = e.target.value;
        if (key === 'symbol') state.symbol = v;
        if (key === 'anchor') state.anchor = Number(v || 0);
        if (key === 'step') state.step = Number(v || 0);
        if (key === 'qty') state.qty = Number(v || 0);
        if (key === 'last') state.lastPrice = v === '' ? null : Number(v);
        updateView();
      });
    });

    byId('zga-copy-buy').addEventListener('click', async () => {
      const l = levels(state.anchor, state.step);
      await navigator.clipboard.writeText(String(l.buy.toFixed(2)));
    });

    byId('zga-copy-sell').addEventListener('click', async () => {
      const l = levels(state.anchor, state.step);
      await navigator.clipboard.writeText(String(l.sell.toFixed(2)));
    });

    byId('zga-copy-plan').addEventListener('click', async () => {
      const l = levels(state.anchor, state.step);
      const text =
`Symbol: ${state.symbol}
Menge: ${state.qty}
Aktueller Anchor: ${l.nextBuyAfterSell.toFixed(2)}
Aktuelle Kauforder: ${l.buy.toFixed(2)}
Aktuelle Verkaufsorder: ${l.sell.toFixed(2)}

Wenn Verkauf bei ${l.sell.toFixed(2)} ausgeführt wurde:
- Alte Kauforder ${l.buy.toFixed(2)} löschen
- Neue Kauforder ${l.nextBuyAfterSell.toFixed(2)} anlegen
- Neue Verkaufsorder ${l.nextSellAfterSell.toFixed(2)} anlegen`;
      await navigator.clipboard.writeText(text);
    });
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function init() {
    if (document.getElementById('zero-grid-assistant')) return;
    createPanel();
    bindEvents();
    updateView();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
