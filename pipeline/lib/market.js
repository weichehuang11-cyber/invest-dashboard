'use strict';
/**
 * 市場健康度資料：
 *   台股寬度（證交所 MI_INDEX 漲跌家數＋累積收盤算站上均線比例、新高新低）
 *   期貨選擇權（期交所：外資台指期未平倉淨額、選擇權 Put/Call 比）
 *   估值（證交所 BWIBBU_ALL 本益比／殖利率／淨值比中位數）
 *   融資餘額（證交所 MI_MARGN 信用交易統計）
 *   信用與金融壓力（FRED：高收益債利差、聖路易聯準會金融壓力指數、芝加哥金融情勢指數）
 * 欄位一律依欄名比對；格式無法辨識就回傳 null，並在 status 記下原因。
 */
const { get, sleep } = require('./http');
const { num, col, prevTradingDate } = require('./twse');

const stripBom = s => String(s || '').replace(/^﻿/, '');
const parseCount = s => { const m = String(s || '').replace(/,/g, '').match(/(\d+)(?:\((\d+)\))?/); return m ? { n: +m[1], limit: m[2] != null ? +m[2] : null } : null; };

// ── 台股寬度 ─────────────────────────────────────────────────
/** MI_INDEX（ALLBUT0999）一次拿到：漲跌家數、全部個股收盤 */
async function miIndex(date) {
  const raw = await get(`https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${date}&type=ALLBUT0999`, { timeout: 25000 });
  if (!raw || raw.stat !== 'OK') return null;
  const tables = raw.tables || [];
  let adv = null, dec = null, unch = null;
  const bt = tables.find(t => /漲跌證券數/.test(t.title || '') && Array.isArray(t.data));
  if (bt) {
    const f = bt.fields || [];
    let ci = col(f, /^股票$/); if (ci < 0) ci = col(f, /整體市場/); if (ci < 0) ci = 1;
    for (const row of bt.data) {
      const k = String(row[0] || '');
      if (/上漲/.test(k)) adv = parseCount(row[ci]);
      else if (/下跌/.test(k)) dec = parseCount(row[ci]);
      else if (/持平/.test(k)) unch = parseCount(row[ci]);
    }
  }
  const ct = tables.find(t => /每日收盤行情/.test(t.title || '') && Array.isArray(t.data));
  const closes = {};
  if (ct) {
    const iC = col(ct.fields || [], /^收盤價$/);
    if (iC >= 0) for (const row of ct.data) { const id = String(row[0] || '').trim(), c = num(row[iC]); if (/^\d{4}$/.test(id) && c > 0) closes[id] = c; }
  }
  if (!adv && !Object.keys(closes).length) return null;
  return { date, adv: adv?.n ?? null, upLimit: adv?.limit ?? null, dec: dec?.n ?? null, downLimit: dec?.limit ?? null, unch: unch?.n ?? null, closes };
}

/**
 * 收盤歷史（只留普通股 4 碼代號）：每次完整更新加入當天，並往回補最多 maxBackfill 天，保留 70 個交易日
 * hist = { dates: [...], c: { id: [close...] }, breadth: [{date, adv, dec, unch, upLimit, downLimit}] }
 */
async function updateTwHistory(hist, latestDate, { maxBackfill = 10, keep = 70, log = () => {} } = {}) {
  hist = hist && hist.dates ? hist : { dates: [], c: {}, breadth: [] };
  const want = []; let d = latestDate;
  for (let i = 0; i < keep && want.length < keep; i++) { want.push(d); d = prevTradingDate(d); }
  const have = new Set(hist.dates);
  const todo = want.filter(x => !have.has(x)).slice(0, maxBackfill + 1);
  const got = {};
  for (const date of todo) {
    const r = await miIndex(date).catch(e => (log('MI_INDEX 失敗', date, e.message), undefined));
    if (r === undefined) break;                 // 連不上就停
    if (r) got[date] = r;                       // null＝休市
    await sleep(2500);
  }
  if (!Object.keys(got).length) return hist;
  // 重新組合（舊資料＋新抓），依日期排序
  const all = {};
  hist.dates.forEach((dt, i) => { all[dt] = { closes: null, idx: i }; });
  const dates = [...new Set([...hist.dates, ...Object.keys(got)])].sort().slice(-keep);
  const ids = new Set([...Object.keys(hist.c), ...Object.values(got).flatMap(g => Object.keys(g.closes))]);
  const c = {};
  for (const id of ids) {
    c[id] = dates.map(dt => {
      if (got[dt]) return got[dt].closes[id] ?? null;
      const i = hist.dates.indexOf(dt); return i >= 0 ? (hist.c[id]?.[i] ?? null) : null;
    });
    if (c[id].every(v => v == null)) delete c[id];
  }
  const bmap = Object.fromEntries((hist.breadth || []).map(b => [b.date, b]));
  for (const [dt, g] of Object.entries(got)) bmap[dt] = { date: dt, adv: g.adv, dec: g.dec, unch: g.unch, upLimit: g.upLimit, downLimit: g.downLimit };
  return { dates, c, breadth: dates.map(dt => bmap[dt]).filter(Boolean) };
}

/** 由收盤歷史算：站上 20／60 日線比例、20 日新高新低家數，以及每日序列（畫走勢用） */
function twBreadthStats(hist) {
  if (!hist?.dates?.length) return null;
  const n = hist.dates.length, ids = Object.keys(hist.c);
  const pctAbove = (k, t) => {
    let a = 0, m = 0;
    for (const id of ids) {
      const s = hist.c[id]; if (s[t] == null || t < k - 1) continue;
      const w = s.slice(t - k + 1, t + 1); if (w.some(v => v == null)) continue;
      m++; if (s[t] > w.reduce((x, y) => x + y, 0) / k) a++;
    }
    return m >= 200 ? a / m * 100 : null;
  };
  const hiLo = t => {
    if (t < 20) return null; let hi = 0, lo = 0, m = 0;
    for (const id of ids) {
      const s = hist.c[id], w = s.slice(t - 20, t); if (s[t] == null || w.some(v => v == null)) continue;
      m++; if (s[t] > Math.max(...w)) hi++; if (s[t] < Math.min(...w)) lo++;
    }
    return m >= 200 ? { hi, lo } : null;
  };
  const series = hist.dates.map((d, t) => ({ date: d, above20: pctAbove(20, t), above60: pctAbove(60, t) }));
  const b = hist.breadth || [], lb = b[b.length - 1];
  const adSeries = b.map(x => ({ date: x.date, net: x.adv != null && x.dec != null ? x.adv - x.dec : null }));
  let cum = 0; const adLine = adSeries.map(x => ({ date: x.date, v: (cum += x.net || 0) }));
  return {
    date: hist.dates[n - 1], days: n,
    adv: lb?.adv ?? null, dec: lb?.dec ?? null, unch: lb?.unch ?? null, upLimit: lb?.upLimit ?? null, downLimit: lb?.downLimit ?? null,
    adRatio5: (() => { const w = b.slice(-5); const a = w.reduce((s, x) => s + (x.adv || 0), 0), d = w.reduce((s, x) => s + (x.dec || 0), 0); return d > 0 ? a / d : null; })(),
    above20: series[n - 1].above20, above60: series[n - 1].above60, newHiLo: hiLo(n - 1),
    series: series.slice(-40), adLine: adLine.slice(-40),
  };
}

// ── 期交所 ───────────────────────────────────────────────────
const big5 = buf => { try { return new TextDecoder('big5').decode(buf); } catch (_) { return Buffer.from(buf).toString('latin1'); } };
async function getBuf(url, timeout = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}
function csvParse(text) {
  const lines = stripBom(text).trim().split(/\r?\n/).filter(l => l.trim());
  const split = l => l.split(',').map(s => s.replace(/^"|"$/g, '').trim());
  const head = split(lines.shift() || '');
  return lines.map(l => Object.fromEntries(split(l).map((v, i) => [head[i] || 'c' + i, v])));
}
const findKey = (obj, ...pats) => Object.keys(obj || {}).find(k => pats.some(p => p.test(k.replace(/\s/g, ''))));
const ymdSlash = ymd => `${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`;
const normDate = s => { const m = String(s || '').match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/); return m ? `${m[1]}${m[2].padStart(2, '0')}${m[3].padStart(2, '0')}` : null; };

/** 外資在臺股期貨（大台）的未平倉淨額（口） */
function pickForeignTX(rows) {
  if (!rows?.length) return null;
  const s = rows[0];
  const kC = findKey(s, /商品名稱|ContractName|Contract$|商品/i), kI = findKey(s, /身份別|身分別|Identity|Institutional|Item/i);
  const kOI = findKey(s, /^多空未平倉口數淨額$/, /未平倉.*口數.*淨額/, /OpenInterest.*Net.*(Volume|Contract)/i, /NetOpenInterest.*Volume/i);
  const kD = findKey(s, /^日期$|^Date$/i);
  if (!kC || !kI || !kOI) return { error: `欄位無法辨識：${Object.keys(s).slice(0, 8).join('|')}` };
  const hit = rows.filter(r => /臺股期貨|台股期貨|^TX$|^TXF$/i.test(String(r[kC]).trim()) && /外資|Foreign/i.test(String(r[kI])));
  if (!hit.length) return { error: '找不到外資臺股期貨列' };
  return { date: normDate(hit[0][kD]), net: num(hit[0][kOI]) };
}
async function taifexForeignTX(date) {
  try {
    const t = await get('https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate', { as: 'text', timeout: 20000 });
    const r = pickForeignTX(JSON.parse(stripBom(t)));
    if (r && !r.error) return { ...r, src: 'openapi' };
  } catch (_) { /* 改用 CSV */ }
  const buf = await getBuf(`https://www.taifex.com.tw/cht/3/futContractsDateDown?queryStartDate=${ymdSlash(date)}&queryEndDate=${ymdSlash(date)}&commodityId=TXF`);
  const r = pickForeignTX(csvParse(big5(buf)));
  return r && !r.error ? { ...r, src: 'csv' } : r;
}

function pickPC(rows) {
  if (!rows?.length) return null;
  const s = rows[0];
  const kD = findKey(s, /^日期$|^Date$/i);
  const kOI = findKey(s, /未平倉.*比率/, /OI.*Ratio|OpenInterest.*Ratio/i);
  const kV = findKey(s, /成交量.*比率/, /Volume.*Ratio/i);
  if (!kOI) return { error: `欄位無法辨識：${Object.keys(s).slice(0, 8).join('|')}` };
  const list = rows.map(r => ({ date: normDate(r[kD]), oi: num(r[kOI]), vol: kV ? num(r[kV]) : null })).filter(x => x.date && x.oi > 0).sort((a, b) => a.date.localeCompare(b.date));
  return list.length ? list : { error: '沒有資料列' };
}
async function taifexPutCall(date) {
  try {
    const t = await get('https://openapi.taifex.com.tw/v1/PutCallRatio', { as: 'text', timeout: 20000 });
    const r = pickPC(JSON.parse(stripBom(t)));
    if (Array.isArray(r)) return r;
  } catch (_) { /* 改用 CSV */ }
  const d0 = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) - 40 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const buf = await getBuf(`https://www.taifex.com.tw/cht/3/pcRatioDown?queryStartDate=${ymdSlash(d0)}&queryEndDate=${ymdSlash(date)}`);
  return pickPC(csvParse(big5(buf)));
}

// ── 估值、融資 ────────────────────────────────────────────────
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
async function twValuation() {
  const rows = await get('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL', { timeout: 20000 });
  if (!Array.isArray(rows) || !rows.length) return null;
  const s = rows[0];
  const kPE = findKey(s, /^PEratio$/i, /本益比/), kDY = findKey(s, /^DividendYield$/i, /殖利率/), kPB = findKey(s, /^PBratio$/i, /淨值比/), kC = findKey(s, /^Code$/i, /代號/);
  if (!kPE) return { error: `欄位無法辨識：${Object.keys(s).join('|')}` };
  const st = rows.filter(r => /^\d{4}$/.test(String(r[kC] || '').trim()));
  const pe = st.map(r => num(r[kPE])).filter(v => v > 0 && v < 200);
  return { pe: median(pe), dy: median(st.map(r => num(r[kDY])).filter(v => v > 0)), pb: median(st.map(r => num(r[kPB])).filter(v => v > 0)), n: pe.length };
}
/** 信用交易統計（全市場）：融資金額今日餘額（億元） */
async function twMargin(date) {
  const raw = await get(`https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${date}&selectType=MS`, { timeout: 20000 });
  if (!raw || raw.stat !== 'OK') return null;
  const tbl = (raw.tables || []).find(t => Array.isArray(t.data) && t.data.some(r => /融資金額/.test(String(r[0])))) || (raw.creditList ? { fields: raw.creditFields, data: raw.creditList } : null);
  if (!tbl) return null;
  const f = tbl.fields || [];
  const iT = col(f, /今日餘額/), iY = col(f, /前日餘額/);
  const row = tbl.data.find(r => /融資金額/.test(String(r[0])));
  if (!row || iT < 0) return null;
  return { date, balance: num(row[iT]) / 1e5, prev: iY >= 0 ? num(row[iY]) / 1e5 : null };   // 仟元 → 億元
}

// ── FRED（公開 CSV，不需權杖）────────────────────────────────
async function fred(id, days = 400) {
  const key = process.env.FRED_API_KEY;
  const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  if (key) {   // 有權杖就用官方 API（較穩定）
    const j = await get(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&observation_start=${cut}`, { timeout: 25000 });
    return (j.observations || []).map(o => ({ date: o.date, v: parseFloat(o.value) })).filter(x => Number.isFinite(x.v));
  }
  const t = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cut}`, { as: 'text', timeout: 30000, headers: { Accept: 'text/csv,*/*' } });
  const rows = csvParse(t);
  const kv = Object.keys(rows[0] || {}).find(k => k.toUpperCase() === id.toUpperCase()) || Object.keys(rows[0] || {})[1];
  const kd = Object.keys(rows[0] || {})[0];
  const out = rows.map(r => ({ date: r[kd], v: parseFloat(r[kv]) })).filter(x => Number.isFinite(x.v));
  return out.filter(x => x.date >= cut);
}

module.exports = { miIndex, updateTwHistory, twBreadthStats, taifexForeignTX, taifexPutCall, pickForeignTX, pickPC, twValuation, twMargin, fred, csvParse, median };
