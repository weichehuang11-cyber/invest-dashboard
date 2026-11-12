'use strict';
/**
 * 即時行情（NAS 代抓，零相依套件）
 *   台股：證交所即時行情（加權、櫃買，約 5 秒）
 *   台指期：期交所行情網（日盤、夜盤自動切換）
 *   其他：Yahoo 一分 K（標普 500、那斯達克、費半、美股期貨、日經、韓股），延遲分鐘數照 Yahoo 標示
 * 開盤中的市場每 10～60 秒抓一次，收盤後每 10 分鐘一次；網站讀 /live.json
 */
const https = require('https');

const LIST = [
  { key: 'TWII', name: '加權指數', src: 'twse', ch: 'tse_t00.tw', ysym: '^TWII', sess: 'tw', every: 10 },
  { key: 'TWOII', name: '櫃買指數', src: 'twse', ch: 'otc_o00.tw', ysym: '^TWOII', sess: 'tw', every: 10 },
  { key: 'TXF', name: '台指期', src: 'taifex', sess: 'txf', every: 10 },
  { key: 'GSPC', name: '標普 500', src: 'yahoo', sym: '^GSPC', sess: 'us', every: 20 },
  { key: 'IXIC', name: '那斯達克', src: 'yahoo', sym: '^IXIC', sess: 'us', every: 20 },
  { key: 'SOX', name: '費城半導體', src: 'yahoo', sym: '^SOX', sess: 'us', every: 20 },
  { key: 'ES', name: '標普期貨', src: 'yahoo', sym: 'ES=F', sess: 'fut', every: 60 },
  { key: 'NQ', name: '那斯達克期貨', src: 'yahoo', sym: 'NQ=F', sess: 'fut', every: 60 },
  { key: 'N225', name: '日經 225', src: 'yahoo', sym: '^N225', sess: 'asia', every: 30 },
  { key: 'KS11', name: '韓國綜合', src: 'yahoo', sym: '^KS11', sess: 'asia', every: 30 },
];

function get(url, { method = 'GET', headers = {}, body, timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, timeout, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', Accept: 'application/json,text/plain,*/*', ...headers } }, res => {
      let d = ''; res.setEncoding('utf8'); res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d, cookie: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ') }));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body) r.write(body); r.end();
  });
}
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

// ── 交易時段（依各市場當地時間）──────────────────────────────
function local(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { wd, hm: (+p.hour % 24) * 60 + +p.minute };
}
// 國定假日／美股假日：每天查一次（查不到就只看週末與時段）
let Hol = null; try { Hol = require('../pipeline/lib/holidays'); } catch (_) { Hol = null; }
const holCache = {};
async function refreshHolidays() {
  if (!Hol) return;
  for (const [m, tz] of [['tw', 'Asia/Taipei'], ['us', 'America/New_York']]) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    if (holCache[m]?.day === day) continue;
    try { holCache[m] = { day, open: await Hol.isTradingDay(m, day) }; } catch (_) { holCache[m] = { day, open: true }; }
  }
}
const holidayClosed = s => ((s === 'tw' || s === 'txfDay') && holCache.tw?.open === false) || (s === 'us' && holCache.us?.open === false);
function session(s) {
  const r = sessionRaw(s);
  if (r === 'open' && holidayClosed(s === 'txf' ? 'txfDay' : s)) return 'closed';
  return r;
}
function sessionRaw(s) {
  if (s === 'tw') { const t = local('Asia/Taipei'); return t.wd >= 1 && t.wd <= 5 && t.hm >= 510 && t.hm <= 820 ? 'open' : 'closed'; }       // 08:30–13:40（含試撮）
  if (s === 'txf') { const t = local('Asia/Taipei'); if (t.wd >= 1 && t.wd <= 5 && t.hm >= 525 && t.hm <= 830) return 'open'; if ((t.wd >= 1 && t.wd <= 5 && t.hm >= 900) || (t.wd >= 2 && t.wd <= 6 && t.hm <= 305)) return 'night'; return 'closed'; }
  if (s === 'us') { const t = local('America/New_York'); return t.wd >= 1 && t.wd <= 5 && t.hm >= 570 && t.hm <= 965 ? 'open' : 'closed'; }
  if (s === 'fut') { const t = local('America/New_York'); const closed = t.wd === 6 || (t.wd === 0 && t.hm < 1080) || (t.wd === 5 && t.hm >= 1020) || (t.wd >= 1 && t.wd <= 4 && t.hm >= 1020 && t.hm < 1080); return closed ? 'closed' : 'open'; }
  if (s === 'asia') { const t = local('Asia/Tokyo'); return t.wd >= 1 && t.wd <= 5 && t.hm >= 540 && t.hm <= 930 ? 'open' : 'closed'; }
  return 'closed';
}

// ── 各來源 ──────────────────────────────────────────────────
let twseCookie = '';
async function twse(items) {
  const url = () => `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${items.map(x => x.ch).join('|')}&json=1&delay=0&_=${Date.now()}`;
  let r = await get(url(), { headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp', ...(twseCookie ? { Cookie: twseCookie } : {}) } });
  let j; try { j = JSON.parse(r.body); } catch (_) { j = null; }
  if (!j?.msgArray?.length) {   // 需要先拿 session
    const h = await get('https://mis.twse.com.tw/stock/index.jsp', { headers: { Accept: 'text/html' } }); twseCookie = h.cookie || twseCookie;
    r = await get(url(), { headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp', Cookie: twseCookie } }); j = JSON.parse(r.body);
  }
  const out = {};
  for (const m of j?.msgArray || []) {
    const it = items.find(x => x.ch.split('_')[1].replace(/\.tw$/, '') === m.c); if (!it) continue;
    const bid = num(String(m.b || '').split('_')[0]), ask = num(String(m.a || '').split('_')[0]);
    const last = num(m.z) ?? (bid && ask ? (bid + ask) / 2 : bid ?? ask) ?? num(m.o) ?? null, prev = num(m.y);
    const d = String(m.d || ''), t = String(m.t || '');
    const time = d.length === 8 && t ? new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t}+08:00`).toISOString() : null;
    out[it.key] = { price: last ?? prev, prev, high: num(m.h), low: num(m.l), time, delay: 0 };
  }
  return out;
}
async function taifex(sess) {
  const body = JSON.stringify({ MarketType: sess === 'night' ? '1' : '0', SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' });
  const r = await get('https://mis.taifex.com.tw/futures/api/getQuoteList', { method: 'POST', body, headers: { 'Content-Type': 'application/json', Referer: 'https://mis.taifex.com.tw/futures/' } });
  const list = JSON.parse(r.body)?.RtData?.QuoteList || [];
  const f = list.find(x => /^TXF/.test(x.SymbolID || '') && !/-S$/.test(x.SymbolID || '') && num(x.CLastPrice));
  if (!f) throw new Error('沒有台指期資料');
  const last = num(f.CLastPrice), prev = num(f.CRefPrice);
  const t = String(f.CTime || '').padStart(6, '0'), d = String(f.CDate || '');
  // 夜盤的 CDate 是「交易日」不是時鐘日期：用台北今天的日期配 CTime，比現在晚就往前一天
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  let tm = Date.parse(`${today}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+08:00`); if (tm > Date.now() + 5 * 60000) tm -= 86400000;
  const time = Number.isFinite(tm) ? new Date(tm).toISOString() : new Date().toISOString(); void d;
  return { price: last, prev, high: num(f.CHighPrice), low: num(f.CLowPrice), time, delay: 0, label: f.DispCName || null, night: sess === 'night' };
}
async function yahoo(sym) {
  const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d&includePrePost=false`);
  if (r.status === 429) throw new Error('Yahoo 限流');
  const res = JSON.parse(r.body)?.chart?.result?.[0]; if (!res) throw new Error('Yahoo 無資料');
  const m = res.meta || {}, c = res.indicators?.quote?.[0]?.close || [], ts = res.timestamp || [];
  const spark = []; for (let i = 0; i < c.length; i++) if (c[i] != null) spark.push([ts[i] * 1000, +c[i].toFixed(2)]);
  return { price: m.regularMarketPrice, prev: m.previousClose ?? m.chartPreviousClose, high: m.regularMarketDayHigh ?? null, low: m.regularMarketDayLow ?? null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, delay: m.exchangeDataDelayedBy ? Math.round(m.exchangeDataDelayedBy / 60) || m.exchangeDataDelayedBy : 0, spark };
}

// ── 狀態與排程 ──────────────────────────────────────────────
const live = { at: null, items: {} };
const due = {};
const afterClose = {};   // 收盤後已經抓了幾次
const spark = {};   // 證交所／期交所沒有分 K：自己每分鐘記一點
const ysp = {};     // 自己記的點太少時（剛啟動），先用 Yahoo 一分 K 補走勢線（每 5 分鐘更新）
async function yahooSpark(sym) {
  const c = ysp[sym]; if (c && Date.now() - c.at < 300000) return c.pts;
  try { const r = await yahoo(sym); ysp[sym] = { at: Date.now(), pts: r.spark || [] }; } catch (_) { ysp[sym] = { at: Date.now(), pts: c?.pts || [] }; }
  return ysp[sym].pts;
}
function addSpark(key, time, price) {
  if (!price) return; const day = (time || new Date().toISOString()).slice(0, 10);
  const S = spark[key] && spark[key].day === day ? spark[key] : (spark[key] = { day, pts: [] });
  const t = Date.parse(time || Date.now()), minute = Math.floor(t / 60000) * 60000, last = S.pts[S.pts.length - 1];
  if (last && last[0] === minute) last[1] = price; else S.pts.push([minute, price]);
  if (S.pts.length > 1200) S.pts.shift();
}
async function tick(force) {
  await refreshHolidays();
  const now = Date.now(), jobs = [];
  const twItems = LIST.filter(x => x.src === 'twse');
  for (const it of LIST) {
    const sess = session(it.sess), every = (sess === 'closed' ? 600 : it.every) * 1000;
    // 休市時不更新：收盤後再抓兩次（剛收盤、10 分鐘後確認收盤價）就停，等下次開盤
    if (sess !== 'closed') afterClose[it.key] = 0;
    else if (live.items[it.key]?.ok && (afterClose[it.key] || 0) >= 2 && !force) { if (live.items[it.key]) live.items[it.key].state = 'closed'; continue; }
    if (!force && due[it.key] && now < due[it.key]) continue;
    if (sess === 'closed') { afterClose[it.key] = (afterClose[it.key] || 0) + 1; if (it.src === 'twse') for (const x of twItems) afterClose[x.key] = afterClose[it.key]; }
    if (it.src === 'twse') { if (it !== twItems[0]) continue; }
    due[it.key] = now + every; if (it.src === 'twse') for (const x of twItems) due[x.key] = now + every;
    jobs.push((async () => {
      try {
        if (it.src === 'twse') {
          const r = await twse(twItems);
          for (const x of twItems) if (r[x.key]) { live.items[x.key] = { ...r[x.key], name: x.name, state: session(x.sess), src: '證交所', ok: true }; addSpark(x.key, r[x.key].time, r[x.key].price); }
        } else if (it.src === 'taifex') {
          const s = session('txf'), r = await taifex(s === 'closed' ? (local('Asia/Taipei').hm < 600 ? 'night' : 'open') : s);
          live.items[it.key] = { ...r, name: it.name + (r.night ? '（夜盤）' : ''), state: s, src: '期交所', ok: true }; addSpark(it.key + (r.night ? 'N' : ''), r.time, r.price);
        } else {
          const r = await yahoo(it.sym);
          live.items[it.key] = { ...r, name: it.name, state: session(it.sess), src: 'Yahoo', ok: true };
        }
      } catch (e) {
        const o = live.items[it.key] || { name: it.name }; live.items[it.key] = { ...o, ok: false, err: String(e.message || e).slice(0, 80), state: session(it.sess) };
        if (it.src === 'twse') for (const x of twItems) live.items[x.key] = { ...(live.items[x.key] || { name: x.name }), ok: false, err: String(e.message || e).slice(0, 80) };
      }
    })());
  }
  await Promise.all(jobs);
  for (const [k, v] of Object.entries(live.items)) {
    if (v.price != null && v.prev) { v.chg = +(v.price - v.prev).toFixed(2); v.chgPct = +((v.price / v.prev - 1) * 100).toFixed(2); }
    // 盤中資料時間落後太多＝來源有延遲（例如 Yahoo 期貨約 10 分鐘）
    if (v.state !== 'closed' && v.time) { const lag = Math.round((Date.now() - Date.parse(v.time)) / 60000); v.lag = lag; if (lag >= 3) v.delay = Math.max(v.delay || 0, lag); }
    const sk = k === 'TXF' && v.night ? 'TXFN' : k;
    if (!v.spark || spark[sk]) v.sparkOwn = spark[sk]?.pts || [];
    const def = LIST.find(x => x.key === k);
    if (def?.ysym && (v.sparkOwn || []).length < 10 && !(k === 'TXF' && v.night)) v.sparkY = await yahooSpark(def.ysym);
  }
  live.at = new Date().toISOString();
  return live;
}
/** 給網站：分 K 只留最近 300 點，數字縮短 */
function snapshotJSON() {
  const items = {};
  for (const it of LIST) {
    const v = live.items[it.key]; if (!v) continue;
    const pts = (v.spark && v.spark.length ? v.spark : (v.sparkOwn || []).length >= 10 ? v.sparkOwn : v.sparkY?.length ? v.sparkY : v.sparkOwn || []).slice(-300);
    items[it.key] = { name: v.name, price: v.price, prev: v.prev, chg: v.chg, chgPct: v.chgPct, high: v.high, low: v.low, time: v.time, delay: v.delay || 0, state: v.state, src: v.src, ok: v.ok, err: v.ok ? undefined : v.err, spark: pts.map(p => p[1]), t0: pts[0]?.[0] || null };
  }
  const st = {}; for (const [k, v] of Object.entries(stocks)) st[k] = { price: v.price, prev: v.prev, chgPct: v.chgPct, high: v.high, low: v.low, time: v.time, delay: v.delay || 0, state: v.state };
  return JSON.stringify({ at: live.at, order: LIST.map(x => x.key), items, stocks: st, alerts: ALERTS_ON });
}

// ── 個股（觀察清單＋持股）：台股證交所每 10 秒一批、美股 Yahoo 每 60 秒 ─────────
let STOCKS = [];   // [{ key, m: 'tw'|'us', ex: 'tse'|'otc' }]
const stocks = {}, sDue = {}, sAfter = { tw: 0, us: 0 };
function setStocks(list) { STOCKS = list; }
async function tickStocks(force) {
  const now = Date.now();
  for (const m of ['tw', 'us']) {
    const L = STOCKS.filter(x => x.m === m); if (!L.length) continue;
    const sess = session(m === 'tw' ? 'tw' : 'us');
    if (sess !== 'closed') sAfter[m] = 0; else if (sAfter[m] >= 2 && !force && L.every(x => stocks[x.key])) continue;
    if (!force && sDue[m] && now < sDue[m]) continue;
    sDue[m] = now + (sess === 'closed' ? 600 : m === 'tw' ? 10 : 60) * 1000; if (sess === 'closed') sAfter[m]++;
    try {
      if (m === 'tw') {
        for (let i = 0; i < L.length; i += 50) {
          const part = L.slice(i, i + 50).map(x => ({ key: x.key, ch: `${x.ex || 'tse'}_${x.key}.tw` }));
          const r = await twse(part); for (const [k, v] of Object.entries(r)) stocks[k] = { ...v, state: sess };
        }
      } else {
        for (const x of L) { try { const r = await yahoo(x.key); stocks[x.key] = { price: r.price, prev: r.prev, high: r.high, low: r.low, time: r.time, delay: r.delay, state: sess }; } catch (_) { /* 下一輪再試 */ } }
      }
    } catch (e) { console.log('個股即時失敗', m, e.message); }
  }
  for (const v of Object.values(stocks)) if (v.price != null && v.prev) v.chgPct = +((v.price / v.prev - 1) * 100).toFixed(2);
}
let ALERTS_ON = false;
function setAlertsOn(v) { ALERTS_ON = !!v; }

module.exports = { tick, tickStocks, setStocks, setAlertsOn, stocks, snapshotJSON, session, LIST, live };
if (require.main === module) (async () => { await tick(true); const j = JSON.parse(snapshotJSON()); for (const k of j.order) { const v = j.items[k]; console.log(`::notice::${k} ${v?.ok ? `${v.price}（${v.chgPct}%）${v.time} 延遲${v.delay} ${v.state} 點數${v.spark.length}` : '失敗 ' + (v?.err || '')}`); } })();
