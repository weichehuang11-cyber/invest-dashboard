'use strict';
/**
 * 臺灣證券交易所：三大法人買賣超（T86）與每日收盤行情（MI_INDEX）。
 * 欄位一律依「欄名」對應（TWSE 會調整欄位順序）。只涵蓋上市股票；上櫃股的法人資料由 FinMind 補。
 */
const { get, sleep } = require('./http');

const num = s => {
  if (typeof s === 'number') return s;
  const n = parseFloat(String(s ?? '').replace(/,/g, '').replace(/<[^>]*>/g, ''));
  return Number.isFinite(n) ? n : 0;
};
function col(fields, ...pats) {
  for (const p of pats) {
    const i = (fields || []).findIndex(f => p.test(String(f).replace(/\s/g, '')));
    if (i >= 0) return i;
  }
  return -1;
}

const twNow = () => new Date(Date.now() + 8 * 3600000);
const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const weekend = d => [0, 6].includes(d.getUTCDay());

/** 最近一個 T86 應已公布的交易日（台北 15:00 前視為前一交易日） */
function lastTradingDate(nowMs = Date.now()) {
  const d = new Date(nowMs + 8 * 3600000);
  if (d.getUTCHours() < 15) d.setUTCDate(d.getUTCDate() - 1);
  while (weekend(d)) d.setUTCDate(d.getUTCDate() - 1);
  return fmt(d);
}
function prevTradingDate(ymd) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  do { d.setUTCDate(d.getUTCDate() - 1); } while (weekend(d));
  return fmt(d);
}

async function t86(date) {
  const raw = await get(`https://www.twse.com.tw/fund/T86?response=json&date=${date}&selectType=ALL`);
  if (!raw || raw.stat !== 'OK' || !raw.data) return null;
  const f = raw.fields || [];
  const C = {
    fNet: col(f, /^外陸資買賣超股數\(不含外資自營商\)$/, /^外資買賣超股數$/),
    fdNet: col(f, /^外資自營商買賣超股數$/),
    tNet: col(f, /^投信買賣超股數$/),
    dNet: col(f, /^自營商買賣超股數$/),
    total: col(f, /^三大法人買賣超股數$/),
  };
  if (C.fNet < 0 || C.tNet < 0 || C.total < 0) throw new Error('T86 欄位格式無法辨識');
  const out = {};
  for (const row of raw.data) {
    const id = String(row[0] || '').trim();
    if (!/^\d{4,6}[A-Z]?$/.test(id)) continue;
    out[id] = {
      id, name: String(row[1] || id).trim(),
      foreign: num(row[C.fNet]) + (C.fdNet >= 0 ? num(row[C.fdNet]) : 0),
      trust: num(row[C.tNet]), dealer: C.dNet >= 0 ? num(row[C.dNet]) : 0, total: num(row[C.total]),
    };
  }
  return out;
}

async function closes(date) {
  const raw = await get(`https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${date}&type=ALLBUT0999`, { timeout: 20000 });
  const tbl = (raw?.tables || []).find(t => /每日收盤行情/.test(t.title || '') && Array.isArray(t.data));
  if (!tbl) return null;
  const f = tbl.fields || [];
  const iC = col(f, /^收盤價$/), iS = col(f, /^漲跌\(\+\/-\)$/), iD = col(f, /^漲跌價差$/);
  if (iC < 0) return null;
  const out = {};
  for (const row of tbl.data) {
    const id = String(row[0] || '').trim(), close = num(row[iC]);
    if (!id || !(close > 0)) continue;
    const sg = String(row[iS] || '');
    const diff = (sg.includes('-') ? -1 : sg.includes('+') ? 1 : 0) * num(row[iD]);
    out[id] = { close, chgPct: close - diff > 0 ? diff / (close - diff) * 100 : 0 };
  }
  return out;
}

/** 取最近一個有資料的交易日（遇國定假日往前找，最多 6 天） */
async function latestChip() {
  let date = lastTradingDate();
  for (let i = 0; i < 6; i++) {
    const chip = await t86(date).catch(() => undefined);
    if (chip === undefined) return null;          // 連不上就放棄
    if (chip && Object.keys(chip).length > 100) {
      await sleep(1500);
      const px = await closes(date).catch(() => null);
      return { date, chip, closes: px || {} };
    }
    date = prevTradingDate(date);
    await sleep(1500);
  }
  return null;
}

module.exports = { t86, closes, latestChip, lastTradingDate, prevTradingDate, num, col };
