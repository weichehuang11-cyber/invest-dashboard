'use strict';
/** 日線技術指標（全部以「日 K、交易日」為單位） */

const last = a => a[a.length - 1];
const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, v) => s + v, 0) / n : null);

function emaSeries(a, n) {
  const k = 2 / (n + 1), out = [a[0]];
  for (let i = 1; i < a.length; i++) out.push(a[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** RSI：與 pandas ewm(com=n-1, adjust=True) 一致 */
function rsi(c, n = 14) {
  if (c.length < n + 1) return null;
  const a = 1 / n; let g = 0, l = 0, den = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = g * (1 - a) + Math.max(0, d); l = l * (1 - a) + Math.max(0, -d); den = den * (1 - a) + 1;
  }
  const ag = g / den, al = l / den;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function macd(c) {
  if (c.length < 35) return null;
  const e26 = emaSeries(c, 26);
  const m = emaSeries(c, 12).map((v, i) => v - e26[i]);
  const s = emaSeries(m, 9);
  const p = last(c);
  return { macdPct: last(m) / p * 100, signalPct: last(s) / p * 100, histPct: (last(m) - last(s)) / p * 100 };
}

function bollinger(c, n = 20) {
  if (c.length < n) return null;
  const w = c.slice(-n), mid = w.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(w.reduce((s, v) => s + (v - mid) ** 2, 0) / (n - 1));
  if (!(sd > 0)) return { pctB: 50, mid, upper: mid, lower: mid };
  const upper = mid + 2 * sd, lower = mid - 2 * sd;
  return { pctB: (last(c) - lower) / (upper - lower) * 100, mid, upper, lower };
}

function atr(h, l, c, n = 14) {
  if (c.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  return tr.slice(-n).reduce((s, v) => s + v, 0) / n;
}

const ret = (c, n) => (c.length > n ? (last(c) / c[c.length - 1 - n] - 1) * 100 : null);

function vol(c, n = 20) {
  if (c.length < n + 1) return null;
  const r = [];
  for (let i = c.length - n; i < c.length; i++) r.push(c[i] / c[i - 1] - 1);
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  return Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100;
}

/** 歷史法 1 日 VaR（95%），以近 252 日日報酬，回傳 % */
function var95(c) {
  if (c.length < 60) return null;
  const w = c.slice(-253), r = [];
  for (let i = 1; i < w.length; i++) r.push(w[i] / w[i - 1] - 1);
  r.sort((a, b) => a - b);
  return -r[Math.floor(0.05 * r.length)] * 100;
}

function compute(bars) {
  const { close: c, high: h, low: l, volume: v } = bars;
  if (!c || c.length < 20) return null;
  const p = last(c);
  const ma20 = sma(c, 20), ma60 = sma(c, 60);
  const a = atr(h, l, c);
  const m = macd(c), b = bollinger(c);
  const vol20 = v && v.length >= 21 ? v.slice(-21, -1).reduce((s, x) => s + x, 0) / 20 : null;
  return {
    rsi: rsi(c), macdPct: m?.macdPct ?? null, macdHistPct: m?.histPct ?? null,
    bbPct: b?.pctB ?? null, ma20, ma60, ma120: sma(c, 120),
    trend: ma20 ? (p > ma20 ? 'up' : 'down') : null,
    cross: ma20 && ma60 ? (ma20 > ma60 ? 'golden' : 'death') : null,
    atr: a, atrPct: a ? a / p * 100 : null, stopLong: a ? p - 2 * a : null,
    ret5: ret(c, 5), ret21: ret(c, 21), ret63: ret(c, 63), ret252: ret(c, 252),
    vol20: vol(c), var95: var95(c),
    relVolume: vol20 > 0 ? last(v) / vol20 : null,
    high52: Math.max(...c.slice(-252)), low52: Math.min(...c.slice(-252)),
  };
}

module.exports = { compute, rsi, macd, bollinger, atr, sma, emaSeries, ret, vol, var95 };
