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
      if (inputs.length 
