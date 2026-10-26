#!/usr/bin/env node
'use strict';
/**
 * pipeline/build.js — 產生 dashboard 用的資料檔
 *
 * 用法：
 *   node pipeline/build.js                 盤中快速更新（報價、日線指標、訊號、模型）
 *   node pipeline/build.js --full=tw       台股收盤後完整更新（＋三大法人、FinMind、記錄當日訊號）
 *   node pipeline/build.js --full=us       美股收盤後完整更新（＋基本面、財報日、記錄當日訊號）
 *   node pipeline/build.js --full=all
 * 選項：
 *   --out=DIR      輸出資料夾（預設 out/data）
 *   --state=DIR    狀態資料夾（預測紀錄、昨日訊號、快取；預設 state）
 *   --archive=DIR  另存一份歷史（NAS 用：每次快照 + 每日收盤）
 * 環境變數：FINMIND_TOKEN（台股法人歷史、月營收；沒有也能跑）
 */
const fs = require('fs');
const path = require('path');
const { mapSeries, sleep } = require('./lib/http');
const Yahoo = require('./lib/yahoo');
const TA = require('./lib/ta');
const TWSE = require('./lib/twse');
const FinMind = require('./lib/finmind');
const Macro = require('./lib/macro');
const Signal = require('./lib/signal');
const Verdict = require('./lib/verdict');
const Outcomes = require('./lib/outcomes');
const Outlook = require('./lib/outlook');
const Market = require('./lib/market');
const Calendar = require('./lib/calendar');
const Fin = require('./lib/financials');
const AI = require('./lib/ai');
const Conviction = require('./lib/conviction');
const News = require('./lib/news');
const Digest = require('./lib/digest');
const NewsAI = require('./lib/newsai');

const ROOT = path.join(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const FULL = args.full === true ? 'all' : (args.full || null);
const fullTW = FULL === 'all' || FULL === 'tw';
const fullUS = FULL === 'all' || FULL === 'us';
const OUT = path.resolve(args.out || path.join(ROOT, 'out', 'data'));
const STATE = path.resolve(args.state || path.join(ROOT, 'state'));
const ARCHIVE = args.archive ? path.resolve(args.archive) : null;
const TOKEN = process.env.FINMIND_TOKEN || '';

const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJSON = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + '.tmp', JSON.stringify(o)); fs.renameSync(p + '.tmp', p); };
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const SECTORS = { XLK: '科技', XLC: '通訊服務', XLY: '非必需消費', XLF: '金融', XLI: '工業', XLV: '醫療', XLP: '必需消費', XLE: '能源', XLB: '原材料', XLU: '公用事業', XLRE: '房地產' };
const INDEX = { '^GSPC': '標普 500', '^IXIC': '那斯達克', '^TWII': '加權指數', '^SOX': '費城半導體', 'USDTWD=X': '美元兌台幣', 'DX-Y.NYB': '美元指數' };

function betaOf(a, b, n) {
  const mb = new Map(b.dates.map((x, i) => [x, b.close[i]]));
  const pairs = a.dates.map((x, i) => [a.close[i], mb.get(x)]).filter(p => p[1] != null).slice(-(n + 1));
  if (pairs.length < 30) return null;
  const ra = [], rb = [];
  for (let i = 1; i < pairs.length; i++) { ra.push(pairs[i][0] / pairs[i - 1][0] - 1); rb.push(pairs[i][1] / pairs[i - 1][1] - 1); }
  const ma = ra.reduce((s, v) => s + v, 0) / ra.length, mbm = rb.reduce((s, v) => s + v, 0) / rb.length;
  let cov = 0, vb = 0;
  for (let i = 0; i < ra.length; i++) { cov += (ra[i] - ma) * (rb[i] - mbm); vb += (rb[i] - mbm) ** 2; }
  return vb > 0 ? cov / vb : null;
}

const pctRank = (arr, v) => (arr.length >= 20 && v != null ? arr.filter(x => x <= v).length / arr.length * 100 : null);
const lastOf = a => (a && a.length ? a[a.length - 1] : null);

/** 市場健康度：寬度、期貨選擇權部位、資金、估值、信用與壓力，附白話解讀 */
function buildHealth({ heavy, daily, vix, tsy, sectorsList }) {
  const H = { tw: {}, us: {}, signals: [] };
  const sig = (sev, tone, text, detail) => H.signals.push({ sev, tone, text, detail });
  // 台股寬度
  const b = Market.twBreadthStats(heavy.tw.hist);
  if (b) {
    H.tw.breadth = b;
    if (b.above20 != null) { if (b.above20 < 25) sig(2, 'neg', `台股僅 ${b.above20.toFixed(0)}% 個股站上 20 日線，市場普遍偏弱`); else if (b.above20 > 75) sig(1, 'pos', `台股 ${b.above20.toFixed(0)}% 個股站上 20 日線，多數股票同步走強`); }
    const tw = daily['^TWII'];
    if (tw && b.adRatio5 != null && TA.ret(tw.bars.close, 5) > 1 && b.adRatio5 < 0.9) sig(2, 'neg', '指數近 5 日上漲，但下跌家數多於上漲家數（漲勢集中在少數權值股）', `近 5 日漲跌家數比 ${b.adRatio5.toFixed(2)}`);
  }
  // 外資台指期
  const fh = heavy.tw.futHist || [];
  if (fh.length) {
    const l = lastOf(fh), p5 = fh[fh.length - 6];
    H.tw.futures = { date: l.date, net: l.net, chg: fh.length > 1 ? l.net - fh[fh.length - 2].net : null, chg5: p5 ? l.net - p5.net : null, pct: pctRank(fh.map(x => x.net), l.net), hist: fh.slice(-40) };
    const c5 = H.tw.futures.chg5, pr = H.tw.futures.pct;
    if (c5 != null && c5 < -10000) sig(2, 'neg', `外資台指期 5 日內淨空單增加 ${Math.abs(c5).toLocaleString()} 口（目前淨${l.net < 0 ? '空' : '多'} ${Math.abs(l.net).toLocaleString()} 口），避險或看空快速升溫`);
    else if (c5 != null && c5 > 10000) sig(1, 'pos', `外資台指期 5 日內回補 ${c5.toLocaleString()} 口空單`);
    else if (pr != null && fh.length >= 20 && pr <= 10) sig(2, 'neg', `外資台指期淨空單 ${Math.abs(l.net).toLocaleString()} 口，處於近期最高的 10%`);
  }
  const pc = heavy.tw.pcHist || [];
  if (pc.length) { const l = lastOf(pc); H.tw.putcall = { date: l.date, oi: l.oi, vol: l.vol, pct: pctRank(pc.map(x => x.oi), l.oi), hist: pc.slice(-40) }; }
  const mg = heavy.tw.marginHist || [];
  if (mg.length) {
    const l = lastOf(mg), p5 = mg[mg.length - 6], p20 = mg[mg.length - 21];
    H.tw.margin = { date: l.date, balance: l.balance, chg: mg.length > 1 ? l.balance - mg[mg.length - 2].balance : null, chg5: p5 ? l.balance - p5.balance : null, chg20: p20 ? l.balance - p20.balance : null, hist: mg.slice(-40) };
    const tw = daily['^TWII'];
    if (p5 && tw && (l.balance / p5.balance - 1) * 100 > 3 && TA.ret(tw.bars.close, 5) < 0) sig(2, 'neg', `融資 5 日增加 ${(l.balance - p5.balance).toFixed(0)} 億但指數下跌，散戶逢低承接、籌碼轉亂`);
  }
  const fo = heavy.tw.foreignHistory || [];
  if (fo.length) { const sum = n => fo.slice(-n).reduce((s2, x) => s2 + (x.valueEst || 0), 0) / 1e8; H.tw.foreignCum = { d5: Math.round(sum(5)), d20: Math.round(sum(20)), days: fo.length }; }
  const vh = heavy.tw.valHist || [];
  if (vh.length) { const l = lastOf(vh); H.tw.valuation = { ...l, pct: pctRank(vh.map(x => x.pe), l.pe), days: vh.length }; }
  // 美股寬度：等權重 vs 市值權重、板塊站上 50 日線
  const rsp = daily.RSP, spy = daily.SPY;
  if (rsp && spy) {
    const rel = n => { const a = TA.ret(rsp.bars.close, n), c = TA.ret(spy.bars.close, n); return a != null && c != null ? a - c : null; };
    H.us.equalWeight = { rel20: r2(rel(20)), rel60: r2(rel(60)) };
    if (rel(20) < -3) sig(2, 'neg', `美股等權重指數近 20 日落後標普 500 ${Math.abs(rel(20)).toFixed(1)} 個百分點，漲勢集中在少數大型股`);
  }
  const above50 = sectorsList.filter(k => { const d = daily[k]; return d && d.bars.close.length > 50 && d.price > TA.sma(d.bars.close, 50); }).length;
  H.us.sectorsAbove50 = { n: above50, of: sectorsList.filter(k => daily[k]).length };
  const v3 = daily['^VIX3M'];
  if (vix?.price && v3?.price) {
    const ratio = vix.price / v3.price;
    H.us.vixTerm = { vix: r2(vix.price), vix3m: r2(v3.price), ratio: r2(ratio, 3) };
    if (ratio > 1) sig(3, 'neg', `VIX 期限結構倒掛（近月 ${vix.price.toFixed(1)} > 三個月 ${v3.price.toFixed(1)}），市場處於急性恐慌`);
  }
  const uv = heavy.us.valHist || [];
  if (uv.length) {
    const l = lastOf(uv), ey = 100 / l.pe, y10 = tsy?.y10 ?? l.y10;
    H.us.valuation = { date: l.date, pe: l.pe, earningsYield: r2(ey), y10, erp: y10 != null ? r2(ey - y10) : null, pct: pctRank(uv.map(x => x.pe), l.pe), days: uv.length };
    if (y10 != null && ey - y10 < 0) sig(1, 'neg', `標普 500 盈餘殖利率 ${ey.toFixed(2)}% 低於 10 年債 ${y10.toFixed(2)}%，股票相對債券偏貴`);
  }
  const M = heavy.macro || {};
  const ser = (a, nb) => { if (!a?.length) return null; const l = lastOf(a), p = a[a.length - 1 - nb]; return { date: l.date, v: l.v, chg: p ? r2(l.v - p.v, 2) : null, pct: pctRank(a.map(x => x.v), l.v), hist: a.slice(-60).map(x => x.v) }; };
  H.us.hy = ser(M.hy, 20); H.us.stress = ser(M.stress, 4); H.us.nfci = ser(M.nfci, 4);
  if (H.us.hy?.chg > 0.5) sig(2, 'neg', `高收益債利差 20 個交易日擴大 ${H.us.hy.chg.toFixed(2)} 個百分點，信用風險升溫`);
  if (H.us.stress?.v > 1) sig(2, 'neg', `聖路易聯準會金融壓力指數 ${H.us.stress.v.toFixed(2)}，高於正常水準`);
  H.signals.sort((x, y) => y.sev - x.sev);
  return H;
}

async function main() {
  const t0 = Date.now();
  const wl = readJSON(path.join(ROOT, 'config', 'watchlist.json'), { us: [], tw: [], names: {} });
  const names = wl.names || {};
  const heavy = readJSON(path.join(STATE, 'heavy.json'), { tw: {}, us: {} });
  const last = readJSON(path.join(STATE, 'last.json'), {});
  let predictions = readJSON(path.join(STATE, 'predictions.json'), []);
  const status = {};
  log(`開始 mode=${FULL ? 'full:' + FULL : 'intraday'} us=${wl.us.length} tw=${wl.tw.length}`);

  // ── 1. 日 K + 報價 ─────────────────────────────────────────────
  const keys = [...wl.us, ...wl.tw, ...Object.keys(INDEX), ...Object.keys(SECTORS), 'RSP', 'SPY', '^VIX3M'];
  const daily = {};
  const wset0 = new Set([...wl.us, ...wl.tw]);
  await mapSeries(keys, async k => { const d = await Yahoo.daily(k, wset0.has(k) ? '5y' : '2y'); if (d) daily[k] = d; }, 300);   // 觀察清單抓 5 年（走勢圖 3／5 年、回測），其他 2 年
  // 指數另抓 10 年日 K：走勢推論與回測需要較長歷史
  const IDX = ['^TWII', '^GSPC', '^IXIC', '^SOX'];
  const longDaily = {};
  await mapSeries(IDX, async k => { const d = await Yahoo.daily(k, '10y').catch(() => null); if (d && d.bars.close.length > 300) longDaily[k] = d; }, 300);
  status.yahoo = `${Object.keys(daily).length}/${keys.length}`;
  log('Yahoo 日 K', status.yahoo);

  // ── 2. 總經 ────────────────────────────────────────────────────
  let vix = await Macro.vix().catch(() => null);
  if (!vix) { const d = await Yahoo.daily('^VIX', '1mo'); if (d) vix = { price: d.price, prevClose: d.prevClose, changePct: d.changePct, date: d.marketDate }; }
  const tsy = await Macro.treasury().catch(() => null);
  status.vix = vix ? 'ok' : 'fail'; status.treasury = tsy ? 'ok' : 'fail';

  // ── 3a. 台股收盤後：三大法人 + FinMind ─────────────────────────
  if (fullTW) {
    const lc = await TWSE.latestChip().catch(e => (log('T86 失敗', e.message), null));
    if (lc) {
      let fv = 0;
      for (const [id, c] of Object.entries(lc.chip)) { const px = lc.closes[id]?.close; if (px) fv += c.foreign * px; }
      const rows = Object.values(lc.chip).map(c => ({ ...c, close: lc.closes[c.id]?.close ?? null, chgPct: lc.closes[c.id]?.chgPct ?? null }))
        .filter(c => c.close).map(c => ({ ...c, foreignValue: c.foreign * c.close, trustValue: c.trust * c.close }));
      const top = (k, dir) => rows.slice().sort((a, b) => dir * (b[k] - a[k])).slice(0, 10)
        .map(c => ({ id: c.id, name: c.name, close: c.close, chgPct: r2(c.chgPct), foreign: Math.round(c.foreign / 1000), trust: Math.round(c.trust / 1000), value: Math.round(c[k] / 1e6) }));
      const fh = (heavy.tw.foreignHistory || []).filter(x => x.date !== lc.date);
      fh.push({ date: lc.date, valueEst: fv });
      heavy.tw.foreignHistory = fh.slice(-30);
      heavy.tw.chipMarket = { date: lc.date, foreignValueEst: fv, topForeignBuy: top('foreignValue', 1), topForeignSell: top('foreignValue', -1), topTrustBuy: top('trustValue', 1) };
      heavy.tw.t86 = Object.fromEntries(wl.tw.map(id => [id, lc.chip[id] || null]));
      status.t86 = lc.date;
    } else status.t86 = 'fail';
    if (TOKEN) {
      heavy.tw.finmind = heavy.tw.finmind || {};
      await mapSeries(wl.tw, async id => {
        const [hist, rev, mg] = await Promise.all([
          FinMind.institutional(id, TOKEN).catch(() => null),
          FinMind.revenueYoY(id, TOKEN).catch(() => null),
          FinMind.margin(id, TOKEN).catch(() => null),
        ]);
        if (hist || rev || mg) heavy.tw.finmind[id] = { hist: hist || heavy.tw.finmind[id]?.hist || [], rev, margin: mg || [] };
      }, 400);
      status.finmind = `${Object.keys(heavy.tw.finmind).length}/${wl.tw.length}`;
    } else status.finmind = 'no-token';
    // 市場寬度、期貨選擇權、估值、融資（失敗不影響其他資料）
    const lastDate = status.t86 && status.t86 !== 'fail' ? status.t86 : TWSE.lastTradingDate();
    try {
      heavy.tw.hist = await Market.updateTwHistory(heavy.tw.hist, lastDate, { maxBackfill: heavy.tw.hist ? 12 : 25, keep: 130, log });
      status.breadth = `${heavy.tw.hist.dates.length} 日`;
    } catch (e) { status.breadth = 'fail: ' + e.message; }
    const push = (k, row, keep = 120) => { const a = (heavy.tw[k] || []).filter(x => x.date !== row.date); a.push(row); heavy.tw[k] = a.sort((x, y) => x.date.localeCompare(y.date)).slice(-keep); };
    try {
      const fx = await Market.taifexForeignTX(lastDate);
      if (fx && !fx.error) { push('futHist', { date: fx.date || lastDate, net: fx.net }); status.futures = fx.src; } else status.futures = 'fail: ' + (fx?.error || '無資料');
    } catch (e) { status.futures = 'fail: ' + e.message; }
    try {
      const pc = await Market.taifexPutCall(lastDate);
      if (Array.isArray(pc)) { for (const r of pc) push('pcHist', r); status.putcall = 'ok'; } else status.putcall = 'fail: ' + (pc?.error || '無資料');
    } catch (e) { status.putcall = 'fail: ' + e.message; }
    try {
      const v = await Market.twValuation();
      if (v && !v.error && v.pe) { push('valHist', { date: lastDate, pe: r2(v.pe), dy: r2(v.dy), pb: r2(v.pb), n: v.n }, 1500); heavy.tw.valPer = v.per; status.valuation = 'ok'; } else status.valuation = 'fail: ' + (v?.error || '無資料');
    } catch (e) { status.valuation = 'fail: ' + e.message; }
    try {
      const m = await Market.twMargin(lastDate);
      if (m) { push('marginHist', { date: lastDate, balance: r2(m.balance, 1) }); if (m.prev != null && !(heavy.tw.marginHist.length > 1)) heavy.tw.marginHist.unshift({ date: TWSE.prevTradingDate(lastDate), balance: r2(m.prev, 1) }); status.margin = 'ok'; } else status.margin = 'fail';
    } catch (e) { status.margin = 'fail: ' + e.message; }
    // 集保大戶持股（每週五更新；超過 6 天才重抓）
    if (!heavy.tw.tdccTs || Date.now() - heavy.tw.tdccTs > 6 * 86400000) {
      try {
        const td = await Market.tdcc(null);
        if (td && !td.error) {
          heavy.tw.tdccAll = Object.fromEntries(Object.entries(td.rows).filter(([id]) => /^(\d{4}|0\d{3,5}[A-Z]?)$/.test(id)).map(([id, o]) => [id, o.b1000]));
          heavy.tw.tdcc = heavy.tw.tdcc || {};
          for (const id of wl.tw) { const o = td.rows[id]; if (!o) continue; const h = (heavy.tw.tdcc[id] || []).filter(x => x.date !== td.date); h.push({ date: td.date, ...o }); heavy.tw.tdcc[id] = h.slice(-26); }
          heavy.tw.tdccTs = Date.now(); status.tdcc = `${td.date}（${Object.keys(td.rows).length} 檔）`;
        } else status.tdcc = 'fail: ' + (td?.error || '無資料');
      } catch (e) { status.tdcc = 'fail: ' + e.message; }
    }
    try { const xd = await Market.twExDividend(); if (xd && !xd.error) { heavy.tw.exdiv = xd; status.exdiv = `${Object.keys(xd).length} 檔`; } else status.exdiv = 'fail: ' + (xd?.error || '無資料'); } catch (e) { status.exdiv = 'fail: ' + e.message; }
    try { const tq = await Market.tpexQuotes(); if (tq && !tq.error) { heavy.tw.tpex = tq; status.tpex = `${Object.keys(tq.rows).length} 檔`; } else status.tpex = 'fail: ' + (tq?.error || '無資料'); } catch (e) { status.tpex = 'fail: ' + e.message; }
    // 財報（季報變動慢：每 5 天更新一次；有 FINMIND_TOKEN 用權杖，沒有用免權杖額度）
    heavy.tw.fin = heavy.tw.fin || {};
    { let ok = 0, err = null;
      const FIN_V = 2;   // 分析規則改版時加 1，強制重新計算
      const due = wl.tw.filter(id => !heavy.tw.fin[id] || heavy.tw.fin[id].v !== FIN_V || Date.now() - (heavy.tw.fin[id].ts || 0) > 5 * 86400000);
      await mapSeries(due, async id => {
        try { const a = Fin.analyze(await Fin.tw(id, TOKEN), { market: 'tw' }); if (a) { heavy.tw.fin[id] = { ...a, ts: Date.now(), v: FIN_V }; ok++; } else err = err || `${id} 無季報`; } catch (e) { err = err || e.message; }
      }, TOKEN ? 500 : 1500);
      status.twFinancials = `${Object.keys(heavy.tw.fin).length}/${wl.tw.length}（本次更新 ${ok}）` + (err ? ` ${err.slice(0, 60)}` : '');
    }
    heavy.tw.ts = Date.now();
  }

  // ── 3b. 美股收盤後：基本面、財報日 ──────────────────────────────
  if (fullUS) {
    try {
      const YF = require('yahoo-finance2').default;
      const yf = typeof YF === 'function' ? new YF({ suppressNotices: ['yahooSurvey'] }) : YF;
      heavy.us.fund = heavy.us.fund || {};
      await mapSeries(wl.us, async s => {
        const q = await yf.quoteSummary(s, { modules: ['financialData', 'calendarEvents', 'summaryDetail', 'defaultKeyStatistics', 'netSharePurchaseActivity', 'majorHoldersBreakdown'] }, { validateResult: false });
        const fd = q.financialData || {}, sd = q.summaryDetail || {}, ks = q.defaultKeyStatistics || {};
        const ed = q.calendarEvents?.earnings?.earningsDate?.[0];
        heavy.us.fund[s] = {
          recommendationMean: fd.recommendationMean ?? null, recommendation: fd.recommendationKey ?? null,
          targetPrice: fd.targetMeanPrice ?? null, revenueGrowth: fd.revenueGrowth != null ? fd.revenueGrowth * 100 : null,
          grossMargin: fd.grossMargins != null ? fd.grossMargins * 100 : null,
          pe: sd.trailingPE ?? null, forwardPE: sd.forwardPE ?? ks.forwardPE ?? null, eps: ks.trailingEps ?? null,
          dividendYield: sd.dividendYield != null ? sd.dividendYield * 100 : null,
          earningsDate: ed ? new Date(ed).toISOString().slice(0, 10) : null,
          exDividendDate: q.calendarEvents?.exDividendDate ? new Date(q.calendarEvents.exDividendDate).toISOString().slice(0, 10) : null,
          pb: ks.priceToBook ?? null,
          insider: q.netSharePurchaseActivity ? { buy: q.netSharePurchaseActivity.buyInfoShares ?? null, sell: q.netSharePurchaseActivity.sellInfoShares ?? null, net: q.netSharePurchaseActivity.netInfoShares ?? null, netPct: q.netSharePurchaseActivity.netPercentInsiderShares != null ? q.netSharePurchaseActivity.netPercentInsiderShares * 100 : null, buyN: q.netSharePurchaseActivity.buyInfoCount ?? null, sellN: q.netSharePurchaseActivity.sellInfoCount ?? null, period: q.netSharePurchaseActivity.period || '6m' } : null,
          holders: q.majorHoldersBreakdown ? { insiders: q.majorHoldersBreakdown.insidersPercentHeld != null ? q.majorHoldersBreakdown.insidersPercentHeld * 100 : null, institutions: q.majorHoldersBreakdown.institutionsPercentHeld != null ? q.majorHoldersBreakdown.institutionsPercentHeld * 100 : null } : null,
        };
      }, 600);
      status.fundamentals = `${Object.keys(heavy.us.fund).length}/${wl.us.length}`;
    } catch (e) { status.fundamentals = 'fail: ' + e.message; }
    try {
      const YF = require('yahoo-finance2').default;
      const yf = typeof YF === 'function' ? new YF({ suppressNotices: ['yahooSurvey'] }) : YF;
      const q = await yf.quoteSummary('SPY', { modules: ['summaryDetail', 'price'] }, { validateResult: false });
      const pe = q.summaryDetail?.trailingPE;
      if (pe > 0) {
        // 用 SPY 最後成交時間（紐約日期）當資料日期：週末、假日補跑時不會多出一筆和前一天一樣的假資料
        const mt = q.price?.regularMarketTime, mtMs = mt instanceof Date ? mt.getTime() : typeof mt === 'number' ? (mt < 1e12 ? mt * 1000 : mt) : Date.parse(mt || '');
        const day0 = Number.isFinite(mtMs) ? new Date(mtMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : new Date().toISOString().slice(0, 10);
        heavy.us.valHist = [...(heavy.us.valHist || []).filter(x => x.date !== day0), { date: day0, pe: r2(pe), y10: tsy?.y10 ?? null }].slice(-1500);
        status.usValuation = 'ok';
      } else status.usValuation = 'fail';
    } catch (e) { status.usValuation = 'fail: ' + e.message; }
    try {
      const YF = require('yahoo-finance2').default;
      const yf = typeof YF === 'function' ? new YF({ suppressNotices: ['yahooSurvey'] }) : YF;
      heavy.us.fin = heavy.us.fin || {};
      let ok = 0, err = null;
      await mapSeries(wl.us, async s => {
        try { const a = Fin.analyze(await Fin.us(yf, s), { market: 'us' }); if (a) { heavy.us.fin[s] = a; ok++; } } catch (e) { err = err || e.message; }
      }, 400);
      status.usFinancials = `${ok}/${wl.us.length}` + (err ? `（${err.slice(0, 60)}）` : '');
    } catch (e) { status.usFinancials = 'fail: ' + e.message; }
    heavy.us.ts = Date.now();
  }

  if (fullUS || (FULL && !heavy.us.universe)) {
    try { const uu = await Market.usUniverse(); heavy.us.universe = uu; status.usUniverse = `${Object.keys(uu.rows).length} 檔（${uu.src}）`; } catch (e) { status.usUniverse = 'fail: ' + e.message; }
  }

  // ── 3c. 信用與金融壓力（FRED 公開 CSV）：完整更新時抓 ───────────
  if (FULL) {
    heavy.macro = heavy.macro || {}; let fredErr = null;
    for (const [k, id] of [['hy', 'BAMLH0A0HYM2'], ['stress', 'STLFSI4'], ['nfci', 'NFCI']]) {
      try { const s2 = await Market.fred(id); if (s2.length) heavy.macro[k] = s2.slice(-300); else fredErr = fredErr || `${id} 無資料`; } catch (e) { fredErr = fredErr || `${id} ${e.message}`; log('FRED 失敗', id, e.message); }
    }
    status.fred = ['hy', 'stress', 'nfci'].filter(k => heavy.macro[k]?.length).length + '/3' + (fredErr ? `（${fredErr}${process.env.FRED_API_KEY ? '' : '；請設定 FRED_API_KEY'}）` : '');
  }

  // ── 4. 每檔：指標、籌碼、基本面、模型、訊號 ─────────────────────
  let Predictor = null;
  try { Predictor = require('./lib/predictor'); await Predictor.init(); } catch (e) { log('模型載入失敗', e.message); Predictor = null; }
  const items = {};
  for (const key of [...wl.us, ...wl.tw]) {
    const d = daily[key];
    if (!d) continue;
    const market = /^\d/.test(key) ? 'tw' : 'us';
    const ta = TA.compute(d.bars);
    let chip = null, fund = null, chipFeat = {};
    if (market === 'tw') {
      const fm = heavy.tw.finmind?.[key];
      const t = heavy.tw.t86?.[key];
      const vol5 = d.bars.volume.slice(-5).reduce((s, v) => s + v, 0) / 1000;
      if (fm?.hist?.length) {
        const h = fm.hist;
        chip = {
          date: h[h.length - 1].date, source: 'FinMind',
          foreign1: r2(h[h.length - 1].foreign, 0), trust1: r2(h[h.length - 1].trust, 0),
          foreign5: r2(FinMind.sum(h, 'foreign', 5), 0), trust5: r2(FinMind.sum(h, 'trust', 5), 0),
          foreign20: r2(FinMind.sum(h, 'foreign', 20), 0), trust20: r2(FinMind.sum(h, 'trust', 20), 0),
          dealer20: r2(FinMind.sum(h, 'dealer', 20), 0),
          foreignStreak: FinMind.consecutive(h, 'foreign'), trustStreak: FinMind.consecutive(h, 'trust'),
          volume5: r2(vol5, 0),
        };
        // 模型籌碼特徵（定義同 ml/train_tw_chip.py）：法人淨買股數 / 當日成交股數
        const volBy = Object.fromEntries(d.bars.dates.map((x, i) => [x, d.bars.volume[i]]));
        const ratio = (row, k) => (volBy[row.date] > 0 ? row[k] * 1000 / volBy[row.date] : 0);
        const lastRow = h[h.length - 1];
        const fr = ratio(lastRow, 'foreign'), tr = ratio(lastRow, 'trust'), dr = ratio(lastRow, 'dealer');
        const m = fm.margin || [];
        const m1 = m[m.length - 1], m0 = m[m.length - 2];
        const c = d.bars.close.slice(-6);
        chipFeat = {
          foreign_net_ratio: fr, trust_net_ratio: tr, dealer_net_ratio: dr, inst_net_ratio: fr + tr + dr,
          foreign_net_ma5: h.slice(-5).reduce((s, x) => s + ratio(x, 'foreign'), 0) / Math.min(5, h.length),
          margin_balance_chg: m1 && m0?.margin > 0 ? m1.margin / m0.margin - 1 : 0,
          short_balance_chg: m1 && m0?.short > 0 ? m1.short / m0.short - 1 : 0,
          margin_short_ratio: m1?.short > 0 ? m1.margin / m1.short : 0,
          near_limit: c.slice(1).filter((x, i) => Math.abs(x / c[i] - 1) > 0.065).length,
        };
      } else if (t) {
        chip = { date: heavy.tw.chipMarket?.date, source: 'TWSE', foreign1: Math.round(t.foreign / 1000), trust1: Math.round(t.trust / 1000), foreign5: null, trust5: null, volume5: r2(vol5, 0) };
      }
      if (fm?.rev) fund = { revenueYoY: r2(fm.rev.yoy, 1), revenuePeriod: fm.rev.period };
      const vp = heavy.tw.valPer?.[key], xd = heavy.tw.exdiv?.[key];
      if (vp || xd) fund = { ...(fund || {}), pe: vp?.pe ?? null, dividendYield: vp?.dy ?? null, pb: vp?.pb ?? null, exDividendDate: xd?.date ?? null, exDividendCash: xd?.cash ?? null, exDividendType: xd?.type || null };
    } else {
      fund = heavy.us.fund?.[key] || null;
    }
    let ml = null;
    if (Predictor && d.bars.close.length >= Predictor.MIN_BARS) {
      const p = await Predictor.predict(key, { closes: d.bars.close, opens: d.bars.open, highs: d.bars.high, lows: d.bars.low, volumes: d.bars.volume }, chipFeat);
      if (!p.error) ml = { label: p.mlSignal, buyProb: p.buyProb, holdProb: p.holdProb, sellProb: p.sellProb, chipMode: p.chipMode };
    }
    // Beta：相對大盤（美股對標普 500、台股對加權指數），依共同交易日對齊，近 120 日
    const bench = daily[market === 'tw' ? '^TWII' : '^GSPC'];
    if (ta && bench) ta.beta = betaOf(d.bars, bench.bars, 120);
    const sig = Signal.score({ ta, changePct: d.changePct, ml, chip, fund, market, vix: vix?.price });
    // 財報體質明確時，基本面證據以財報為準（月營收／分析師評等為輔）
    const finA = market === 'tw' ? heavy.tw.fin?.[key] : heavy.us.fin?.[key];
    if (finA && Math.abs(finA.score) >= 2) sig.evidence.fund = finA.score > 0 ? 'pos' : 'neg';
    items[key] = {
      key, market, name: names[key] || d.name || key, currency: d.currency,
      divs: (d.divs || []).filter(x => x.date >= new Date(Date.now() - 3 * 366 * 86400000).toISOString().slice(0, 10)),
      price: r2(d.price, 4), prevClose: r2(d.prevClose, 4), changePct: r2(d.changePct), marketDate: d.marketDate, marketTime: d.marketTime,
      ta: ta && Object.fromEntries(Object.entries(ta).map(([k, v]) => [k, typeof v === 'number' ? r2(v, 4) : v])),
      chip, fund, ml, signal: { ...sig, stop: ta?.stopLong ? r2(ta.stopLong, 2) : null },
      fin: (market === 'tw' ? heavy.tw.fin?.[key] : heavy.us.fin?.[key]) || null,
      tdcc: market === 'tw' ? (heavy.tw.tdcc?.[key] || null) : null,
      outlook: (() => { try { return Outlook.analyze(d.bars, { window: 500, backtestDays: 400 }); } catch (e) { log('outlook 失敗', key, e.message); return null; } })(),
    };
  }
  log('個股完成', Object.keys(items).length);

  // ── 4a. 高信心訊號：信心分數＋5 年回測（樣本＝台灣 50／標普 100 大型股＋觀察清單，依市場與大盤環境分開驗證）──
  const conviction = {};
  {
    const UNIV = readJSON(path.join(ROOT, 'config', 'backtest-universe.json'), { tw: [], us: [] });
    heavy.convEval = heavy.convEval || {};
    const benchOf = m => longDaily[m === 'tw' ? '^TWII' : '^GSPC'] || daily[m === 'tw' ? '^TWII' : '^GSPC'];
    const cur = { tw: [], us: [] };
    for (const it of Object.values(items)) {
      const d = daily[it.key], bench = benchOf(it.market);
      if (!d || !bench || d.bars.close.length < 300) continue;
      try { cur[it.market].push({ it, b: d.bars, sc: Conviction.score(d.bars, bench.bars) }); } catch (e) { log('信心分數失敗', it.key, e.message); }
    }
    for (const m of ['tw', 'us']) {
      const bench = benchOf(m);
      const needEval = (m === 'tw' ? fullTW : fullUS) || !heavy.convEval[m];
      if (needEval && bench) {
        const sample = [...cur[m].map(x => ({ key: x.it.key, b: x.b, sc: x.sc }))];
        const have = new Set(cur[m].map(x => x.it.key));
        await mapSeries((UNIV[m] || []).filter(k => !have.has(k)), async k => {
          const d = await Yahoo.daily(k, '5y').catch(() => null);
          if (d && d.bars.close.length >= 300) sample.push({ key: k, b: d.bars, sc: Conviction.score(d.bars, bench.bars) });
        }, 250);
        const ev = Conviction.evaluate(sample);
        heavy.convEval[m] = { ...ev, stocks: sample.length, at: new Date().toISOString() };
        // 台股籌碼：FinMind 法人歷史（約 4.5 年），回測籌碼分數與「技術＋籌碼同步」
        if (m === 'tw' && TOKEN) {
          const chipSample = [], comboSample = [];
          await mapSeries(sample, async x => {
            const hist = await FinMind.institutional(x.key, TOKEN, 1700).catch(() => null);
            if (!hist?.length) return;
            const cs = Conviction.chipScore(x.b, hist, x.sc);
            chipSample.push({ b: x.b, sc: cs }); comboSample.push({ b: x.b, sc: Conviction.comboScore(x.sc, cs) });
          }, 400);
          if (chipSample.length) {
            heavy.convEval.twChip = { ...Conviction.evaluate(chipSample), stocks: chipSample.length, at: new Date().toISOString() };
            heavy.convEval.twCombo = { ...Conviction.evaluate(comboSample), stocks: comboSample.length, at: new Date().toISOString() };
          }
          status.chipBacktest = `${chipSample.length} 檔`;
        }
      }
      const ev = heavy.convEval[m]; if (!ev) continue;
      conviction[m] = ev;
      if (m === 'tw') { if (heavy.convEval.twChip) conviction.twChip = heavy.convEval.twChip; if (heavy.convEval.twCombo) conviction.twCombo = heavy.convEval.twCombo; }
      const lastBench = bench?.bars?.close || [], regNow = (() => { const a = lastBench.slice(-200); return a.length === 200 ? (a[199] > a.reduce((x, y) => x + y, 0) / 200 ? 'bull' : 'bear') : null; })();
      conviction[m].regimeNow = regNow;
      for (const { it, sc } of cur[m]) {
        const last = sc.scores[sc.scores.length - 1]; if (!last) continue;
        const bucket = Conviction.bucketOf(last.score), row = ev.table[bucket] || {}, rrow = regNow ? ev.regimes?.[regNow]?.[bucket] : null;
        const highs = [];
        for (const k of ['ex20', 'ex5', 'up20']) {
          if (rrow?.[k]?.high) highs.push({ target: k, hit: rrow[k].test.hit, n: rrow[k].test.n, avg: rrow[k].test.avg, regime: regNow });
          else if (row[k]?.high) highs.push({ target: k, hit: row[k].test.hit, n: row[k].test.n, avg: row[k].test.avg, regime: null });
        }
        it.conv = { score: last.score, bucket, dir: row.dir, regime: regNow, items: last.items.map(([name, pt, txt]) => ({ name, pt, txt })), high: highs };
        // 台股：今日籌碼分數（用 FinMind 近 60 日法人資料）與技術＋籌碼同步
        const fmHist = m === 'tw' ? heavy.tw.finmind?.[it.key]?.hist : null;
        if (fmHist?.length >= 20 && heavy.convEval.twChip) {
          const cs = Conviction.chipScore(daily[it.key].bars, fmHist, sc), cl = cs.scores[cs.scores.length - 1];
          if (cl) {
            const ce = heavy.convEval.twChip, cb = Conviction.bucketOf(cl.score), crow = ce.table[cb] || {}, crr = regNow ? ce.regimes?.[regNow]?.[cb] : null;
            const comboV = last.score >= 3 && cl.score >= 2 ? 5 : last.score <= -3 && cl.score <= -2 ? -5 : 0;
            const xe = heavy.convEval.twCombo, xb = Conviction.bucketOf(comboV), xrow = xe?.table?.[xb] || {}, xrr = regNow ? xe?.regimes?.[regNow]?.[xb] : null;
            const add = (src, row2, rr, label) => { for (const k of ['ex20', 'ex5', 'up20']) { if (rr?.[k]?.high) highs.push({ target: k, hit: rr[k].test.hit, n: rr[k].test.n, avg: rr[k].test.avg, regime: regNow, src: label }); else if (row2?.[k]?.high) highs.push({ target: k, hit: row2[k].test.hit, n: row2[k].test.n, avg: row2[k].test.avg, regime: null, src: label }); } };
            add('chip', crow, crr, '籌碼'); if (comboV) add('combo', xrow, xrr, '技術＋籌碼');
            it.conv.chip = { score: cl.score, bucket: cb, items: cl.items.map(([name, pt, txt]) => ({ name, pt, txt })), combo: comboV ? (comboV > 0 ? '同步偏多' : '同步偏空') : null };
            if (!it.conv.dir && highs.length) it.conv.dir = cl.score < 0 ? -1 : 1;
          }
        }
      }
    }
    status.conviction = Object.entries(conviction).map(([m, e]) => `${m} ${e.stocks || '?'} 檔／${e.n} 筆`).join('、') || '無';
    if (!TOKEN) status.chipBacktest = 'no-token';
  }

  // ── 4b. 模型樣本外紀錄：訓練日之後每天的模型判斷（回測頁用，避免用訓練過的資料自我評分）──
  const mlHist = {};
  const trainedAt = m => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'ml', 'models', m === 'tw' ? 'scaler_tw.json' : 'scaler.json'), 'utf8')).trained_at?.slice(0, 10) || null; } catch (_) { return null; } };
  const TA_AT = { tw: trainedAt('tw'), us: trainedAt('us') };
  if (Predictor) {
    for (const it of Object.values(items)) {
      const d = daily[it.key], t0 = TA_AT[it.market]; if (!d || !t0) continue;
      const B = d.bars, out = [];
      for (let i = B.dates.length - 1; i >= 60 && B.dates[i] > t0 && out.length < 120; i--) {
        const sl = a => a.slice(0, i + 1);
        try { const p = await Predictor.predict(it.key, { closes: sl(B.close), opens: sl(B.open), highs: sl(B.high), lows: sl(B.low), volumes: sl(B.volume) }, {}); if (!p.error) out.unshift({ date: B.dates[i], buy: r2(p.buyProb, 3), sell: r2(p.sellProb, 3), label: p.mlSignal }); } catch (_) { break; }
      }
      mlHist[it.key] = out;
    }
  }
  const oos = (() => {
    const rows = [];
    for (const it of Object.values(items)) {
      const B = daily[it.key]?.bars; if (!B) continue;
      const idx = new Map(B.dates.map((x, i) => [x, i]));
      for (const h of mlHist[it.key] || []) { const i = idx.get(h.date); if (i == null || i + 1 >= B.close.length) continue; rows.push({ market: it.market, label: h.label, r: (B.close[i + 1] / B.close[i] - 1) * 100 }); }
    }
    const grp = f => { const g = rows.filter(f); return { n: g.length, avg: g.length ? r2(g.reduce((s2, x) => s2 + x.r, 0) / g.length, 3) : null, up: g.length ? r2(g.filter(x => x.r > 0).length / g.length * 100, 1) : null }; };
    return { since: TA_AT, all: grp(() => true), buy: grp(x => x.label === 'BUY'), sell: grp(x => x.label === 'SELL'), hold: grp(x => x.label === 'HOLD'),
      hit: (() => { const g = rows.filter(x => x.label !== 'HOLD' && Math.abs(x.r) >= 0.5); return g.length ? { n: g.length, rate: r2(g.filter(x => (x.label === 'BUY') === (x.r > 0)).length / g.length * 100, 1) } : null; })() };
  })();

  // ── 5. 市場環境、板塊、判斷 ─────────────────────────────────────
  const ix = k => { const d = daily[k]; if (!d) return null; return { price: d.price, changePct: d.changePct, ta: TA.compute(d.bars), date: d.marketDate }; };
  const spx = ix('^GSPC'), twii = ix('^TWII'), ndx = ix('^IXIC'), twd = ix('USDTWD=X'), dxy = ix('DX-Y.NYB');
  const fh = heavy.tw.foreignHistory || [];
  let streak = 0;
  for (let i = fh.length - 1; i >= 0 && Math.sign(fh[i].valueEst) === Math.sign(fh[fh.length - 1]?.valueEst); i--) streak++;
  const foreign = fh.length ? { valueEst: fh[fh.length - 1].valueEst, date: fh[fh.length - 1].date, streak } : null;
  const curve = tsy ? { spread: tsy.y10 != null && tsy.y2 != null ? tsy.y10 - tsy.y2 : null, prev: tsy.y10Prev != null && tsy.y2Prev != null ? tsy.y10Prev - tsy.y2Prev : null, y10: tsy.y10, y2: tsy.y2, date: tsy.date } : null;
  const maMeaning = x => !x?.ta?.ma20 ? '' : x.price > x.ta.ma20 ? (x.ta.ma60 && x.price < x.ta.ma60 ? '站上 20 日線，仍低於 60 日線' : '站上 20 日線') : '跌破 20 日線';
  const env = [
    twii && { key: 'twii', label: '加權指數', value: r2(twii.price, 0), changePct: r2(twii.changePct), meaning: maMeaning(twii), date: twii.date },
    spx && { key: 'spx', label: '標普 500 指數', value: r2(spx.price, 0), changePct: r2(spx.changePct), meaning: maMeaning(spx), date: spx.date },
    ndx && { key: 'ndx', label: '那斯達克指數', value: r2(ndx.price, 0), changePct: r2(ndx.changePct), meaning: maMeaning(ndx), date: ndx.date },
    vix && { key: 'vix', label: 'VIX 恐慌指數', value: r2(vix.price), changePct: r2(vix.changePct, 1), inverse: true, meaning: vix.price > 25 ? '恐慌升高' : vix.price > 20 ? '高於 20：波動升溫' : vix.price < 15 ? '波動低' : '正常區間', date: vix.date },
    curve?.spread != null && { key: 'curve', label: '美債 10 年減 2 年利差', value: r2(curve.spread), unit: '百分點', change: curve.prev != null ? r2(curve.spread - curve.prev) : null, meaning: curve.spread < 0 ? '曲線倒掛' : '正斜率，未倒掛', date: curve.date },
    twd && { key: 'twd', label: '美元兌台幣', value: r2(twd.price, 3), changePct: r2(twd.changePct), inverse: true, meaning: twd.changePct > 0 ? '台幣貶值' : twd.changePct < 0 ? '台幣升值' : '持平', date: twd.date },
    foreign && { key: 'foreign', label: '外資（台股，估算）', value: r2(foreign.valueEst / 1e8, 0), unit: '億', meaning: `${foreign.valueEst < 0 ? '賣超' : '買超'}${streak >= 2 ? `，連 ${streak} 日` : ''}`, date: foreign.date },
    dxy && { key: 'dxy', label: '美元指數', value: r2(dxy.price), changePct: r2(dxy.changePct), meaning: dxy.changePct > 0 ? '美元走強' : '美元走弱', date: dxy.date },
  ].filter(Boolean);
  const sectors = Object.entries(SECTORS).map(([etf, name]) => {
    const d = daily[etf]; if (!d) return null;
    return { etf, name, changePct: r2(d.changePct), ret5: r2(TA.ret(d.bars.close, 5)), ret21: r2(TA.ret(d.bars.close, 21)), ret63: r2(TA.ret(d.bars.close, 63)) };
  }).filter(Boolean).sort((a, b) => (b.ret21 ?? -99) - (a.ret21 ?? -99));
  const health = buildHealth({ heavy, daily, vix, tsy, sectorsList: Object.keys(SECTORS) });
  const verdict = Verdict.build({ vix, spx: spx && { ...spx }, twii, foreign, curve, health }, last.verdict);
  const calendar = Calendar.build({ config: readJSON(path.join(ROOT, 'config', 'events.json'), { events: [] }).events, items, today: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) });

  // ── 6. 今天有什麼變了 ──────────────────────────────────────────
  const changes = [];
  const SIGZH = { BUY: '買進', SELL: '賣出', HOLD: '觀望' };
  const today = new Date().toISOString().slice(0, 10);
  for (const it of Object.values(items)) {
    const prev = last.signals?.[it.key];
    if (prev && prev !== it.signal.sig && it.signal.sig !== 'HOLD') {
      const ev = it.signal.evidence, agree = Object.values(ev).filter(v => v === (it.signal.sig === 'BUY' ? 'pos' : 'neg')).length;
      changes.push({ tag: '訊號', sev: 3, key: it.key, title: `${it.key} ${it.name} 轉為${SIGZH[it.signal.sig]}`, detail: `分數 ${it.signal.score}，${agree} 項證據同向（原為${SIGZH[prev]}）` });
    }
    if (it.chip?.foreignStreak && Math.abs(it.chip.foreignStreak) >= 3) {
      changes.push({ tag: '籌碼', sev: 2, key: it.key, title: `${it.key} ${it.name} 外資連 ${Math.abs(it.chip.foreignStreak)} 日${it.chip.foreignStreak > 0 ? '買超' : '賣超'}`, detail: `近 5 日外資 ${it.chip.foreign5 > 0 ? '+' : ''}${it.chip.foreign5?.toLocaleString() ?? '—'} 張、投信 ${it.chip.trust5 > 0 ? '+' : ''}${it.chip.trust5?.toLocaleString() ?? '—'} 張` });
    }
    if (it.fund?.earningsDate) {
      const days = Math.round((Date.parse(it.fund.earningsDate) - Date.parse(today)) / 86400000);
      if (days >= 0 && days <= 7) changes.push({ tag: '事件', sev: days <= 3 ? 3 : 1, key: it.key, title: `${it.name}（${it.key}）財報${days === 0 ? '今天' : ` ${days} 天後`}（${it.fund.earningsDate}）`, detail: it.ta?.vol20 ? `年化波動 ${it.ta.vol20.toFixed(0)}%，財報前後波動通常放大` : '財報前後波動通常放大' });
    }
    const td = it.tdcc;
    if (td?.length >= 2) {
      const a = td[td.length - 1], b0 = td[td.length - 2], d1 = a.b1000 - b0.b1000;
      if (Math.abs(d1) >= 0.8) changes.push({ tag: '籌碼', sev: 2, key: it.key, title: `${it.key} ${it.name} 千張大戶持股${d1 > 0 ? '增加' : '減少'} ${Math.abs(d1).toFixed(2)} 個百分點`, detail: `目前 ${a.b1000.toFixed(1)}%（集保 ${a.date}），股東人數 ${a.holders?.toLocaleString() ?? '—'}` });
    }
    if (it.changePct != null && Math.abs(it.changePct) >= 4) {
      changes.push({ tag: '價格', sev: 2, key: it.key, title: `${it.key} ${it.name} ${it.changePct > 0 ? '大漲' : '大跌'} ${Math.abs(it.changePct).toFixed(1)}%`, detail: it.ta?.relVolume ? `成交量為 20 日均量的 ${it.ta.relVolume.toFixed(1)} 倍` : '' });
    }
  }
  if (vix?.prevClose != null) for (const lv of [20, 25, 30]) {
    if (vix.prevClose < lv && vix.price >= lv) changes.push({ tag: '市場', sev: 2, title: `VIX 恐慌指數升破 ${lv}`, detail: `買進門檻自動提高至 ${Signal.buyThreshold(vix.price)} 分` });
    if (vix.prevClose >= lv && vix.price < lv) changes.push({ tag: '市場', sev: 1, title: `VIX 恐慌指數回落到 ${lv} 以下`, detail: `買進門檻 ${Signal.buyThreshold(vix.price)} 分` });
  }
  for (const e of calendar) {
    const dd = Math.round((Date.parse(e.date) - Date.parse(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10))) / 86400000);
    if (e.kind === 'macro' && e.importance >= 3 && dd <= 2) changes.push({ tag: '事件', sev: 2, title: `${e.title}${dd === 0 ? '今天' : dd === 1 ? '明天' : '後天'}（${e.date}）`, detail: '公布前後市場波動通常放大' });
  }
  for (const sg of health.signals.filter(x => x.sev >= 2)) changes.push({ tag: '市場', sev: sg.sev, title: sg.text, detail: sg.detail || '' });
  for (const it of Object.values(items)) {
    if (it.conv?.high?.length) { const h = it.conv.high[0], T = { ex20: '20 日贏大盤', ex5: '5 日贏大盤', up20: '20 日上漲' }; changes.push({ tag: '訊號', sev: 3, key: it.key, title: `${it.key} ${it.name} 高信心${it.conv.dir < 0 ? '偏空' : '偏多'}（${it.conv.bucket}，信心 ${it.conv.score > 0 ? '+' : ''}${it.conv.score}）`, detail: `過去 5 年同樣情況，${T[h.target]}${it.conv.dir < 0 ? '的相反方向' : ''}命中率 ${h.hit}%（驗證期 ${h.n} 次）` }); }
  }
  changes.sort((a, b) => b.sev - a.sev);

  // ── 7. 預測紀錄（收盤後記錄當日訊號）與成績單 ───────────────────
  const nowIso = new Date().toISOString();
  for (const it of Object.values(items)) {
    const logIt = (it.market === 'tw' && fullTW) || (it.market === 'us' && fullUS);
    if (!logIt || it.signal.sig === 'HOLD') continue;
    if (predictions.some(p => p.key === it.key && p.date === it.marketDate)) continue;
    predictions.push({ key: it.key, market: it.market, date: it.marketDate, timestamp: nowIso, signal: it.signal.sig, score: it.signal.score, price: it.price, buyProb: it.ml?.buyProb ?? null });
  }
  predictions = predictions.filter(p => Date.parse(p.timestamp) > Date.now() - 400 * 86400000);
  for (const p of predictions) {
    const d = daily[p.key]; if (!d) continue;
    for (const n of [1, 5, 20]) {
      if (p[`r${n}`] != null) continue;
      const o = Outcomes.closeAfter({ dates: d.bars.dates, closes: d.bars.close }, p.key, p.timestamp, n);
      if (o) { p[`p${n}`] = r2(o.close, 4); p[`r${n}`] = Outcomes.judgeSignal(p.signal, p.price, o.close, 0.5); }
    }
  }
  const rate = (n, days) => {
    const rows = predictions.filter(p => Date.parse(p.timestamp) > Date.now() - days * 86400000 && p[`r${n}`] && p[`r${n}`] !== 'neutral');
    const ok = rows.filter(p => p[`r${n}`] === 'correct').length;
    return { n: rows.length, correct: ok, rate: rows.length ? r2(ok / rows.length * 100, 1) : null };
  };
  const scorecard = {
    since: predictions[0]?.date || null, total: predictions.length,
    d30: { h1: rate(1, 30), h5: rate(5, 30), h20: rate(20, 45) },
    d90: { h1: rate(1, 90), h5: rate(5, 90), h20: rate(20, 120) },
    modelOOS: oos,
    note: '收盤後記錄買進／賣出訊號，依之後第 N 個交易日收盤判定；漲跌未達 ±0.5% 不計入。',
  };

  // ── 8. 輸出 ────────────────────────────────────────────────────
  const IDX_NAME = { '^TWII': '加權指數', '^GSPC': '標普 500', '^IXIC': '那斯達克', '^SOX': '費城半導體' };
  const indices = {};
  for (const k of IDX) {
    const d = longDaily[k] || daily[k]; if (!d) continue;
    let o = null; try { o = Outlook.analyze(d.bars, { window: 750, backtestDays: 1250 }); } catch (e) { log('指數 outlook 失敗', k, e.message); }
    const dd = d;   // 價格、走勢圖與推論用同一份資料
    indices[k] = { key: k, name: IDX_NAME[k], price: r2(dd.price, 2), changePct: r2(dd.changePct), marketDate: dd.marketDate, years: r2(d.bars.close.length / 250, 1), outlook: o };
  }
  status.indices = `${Object.values(indices).filter(x => x.outlook).length}/${IDX.length}`;
  const ranking = Object.values(items).sort((a, b) => b.signal.score - a.signal.score).map(x => x.key);
  const snapshot = {
    version: 1, generatedAt: nowIso, mode: FULL ? `full:${FULL}` : 'intraday', buildSeconds: Math.round((Date.now() - t0) / 1000),
    status, verdict, env, items, ranking, changes, sectors, scorecard, indices, health, calendar, conviction,
    chipMarket: heavy.tw.chipMarket || null,
    watchlist: { us: wl.us, tw: wl.tw },
  };
  // 雲端 AI 解讀：收盤後完整更新時產生，盤中沿用上一次的
  // 收盤後完整更新、判斷等級改變，或距上次超過 3 小時，就重寫（結果存 state/ai.json，盤中也能保存）
  {
    const aFile = path.join(STATE, 'ai.json'), aPrev = readJSON(aFile, null) || heavy.ai || null;
    const stale = !aPrev?.at || Date.now() - Date.parse(aPrev.at) > 3 * 3600000;
    const changed = aPrev && aPrev.level != null && aPrev.level !== verdict.level;
    const backoff = aPrev?.errAt && Date.now() - Date.parse(aPrev.errAt) < 60 * 60000;
    if ((process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY) && (FULL || ((stale || changed) && !backoff))) {
      try { heavy.ai = { ...(await AI.commentary(snapshot)), level: verdict.level, headline: verdict.headline }; writeJSON(aFile, heavy.ai); console.log('DIGEST_CHANGED'); status.ai = `ok（${heavy.ai.model}）`; }
      catch (e) { status.ai = 'fail: ' + e.message.slice(0, 300); heavy.ai = aPrev; if (aPrev) { writeJSON(aFile, { ...aPrev, err: status.ai, errAt: new Date().toISOString() }); console.log('DIGEST_CHANGED'); } }
    } else heavy.ai = aPrev;
  }
  snapshot.ai = heavy.ai || null;
  writeJSON(path.join(OUT, 'snapshot.json'), snapshot);
  for (const key of Object.keys(items)) {
    const d = daily[key];
    const n = 1260, sl = a => a.slice(-n);
    writeJSON(path.join(OUT, 'bars', `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), {
      key, dates: sl(d.bars.dates), open: sl(d.bars.open).map(v => r2(v, 4)), high: sl(d.bars.high).map(v => r2(v, 4)),
      low: sl(d.bars.low).map(v => r2(v, 4)), close: sl(d.bars.close).map(v => r2(v, 4)), volume: sl(d.bars.volume),
      chipHistory: heavy.tw.finmind?.[key]?.hist?.slice(-40) || null,
      predictions: predictions.filter(p => p.key === key).slice(-15),
      mlHist: mlHist[key] || [],
    });
  }
  // 大盤日 K（個人決策紀錄用來比較「同期大盤」）
  for (const key of [...IDX, 'USDTWD=X']) {
    const d = longDaily[key] || daily[key]; if (!d) continue;
    const sl = a => a.slice(-1260);
    writeJSON(path.join(OUT, 'bars', `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), {
      key, dates: sl(d.bars.dates), open: sl(d.bars.open).map(v => r2(v, 4)), high: sl(d.bars.high).map(v => r2(v, 4)),
      low: sl(d.bars.low).map(v => r2(v, 4)), close: sl(d.bars.close).map(v => r2(v, 4)), volume: sl(d.bars.volume),
    });
  }
  // 全市場清單（搜尋與快速檢視用）：台股上市（含 ETF）＋上櫃；觀察清單另標記
  {
    const H = heavy.tw.hist || {}, U = [], series = { dates: (H.dates || []).slice(-60), c: {} };
    const wset = new Set([...wl.us, ...wl.tw]);
    const nD = (H.dates || []).length;
    for (const [id, arr] of Object.entries(H.c || {})) {
      const last = arr[nD - 1]; if (!(last > 0)) continue;
      const cl = arr.slice(-60);
      const ma = k => { const w = arr.slice(-k); return w.length === k && w.every(v => v > 0) ? w.reduce((a, b) => a + b, 0) / k : null; };
      const m20 = ma(20), m60 = ma(60), r20 = arr[nD - 21] > 0 ? (last / arr[nD - 21] - 1) * 100 : null;
      const vp = heavy.tw.valPer?.[id];
      U.push({ k: id, n: H.names?.[id] || id, m: 'tw', x: 'TWSE', c: last, p: r2(H.lastChg?.[id] ?? null), a20: m20 ? last > m20 : null, a60: m60 ? last > m60 : null, r20: r2(r20, 1), pe: vp?.pe ?? undefined, dy: vp?.dy ?? undefined, b: heavy.tw.tdccAll?.[id] ?? undefined, w: wset.has(id) ? 1 : 0 });
      series.c[id] = cl.map(v => (v > 0 ? r2(v, 2) : null));
    }
    const twIds = new Set(U.map(u => u.k));
    for (const [id, q] of Object.entries(heavy.tw.tpex?.rows || {})) if (/^(\d{4}|0\d{3,5}[A-Z]?)$/.test(id) && !twIds.has(id)) U.push({ k: id, n: q.n, m: 'tw', x: 'TPEx', c: q.c, p: r2(q.p), b: heavy.tw.tdccAll?.[id] ?? undefined, w: wset.has(id) ? 1 : 0 });
    for (const k of wl.us) if (items[k]) U.push({ k, n: items[k].name, m: 'us', x: 'US', c: items[k].price, p: items[k].changePct, mc: heavy.us.universe?.rows?.[k]?.mc ?? null, w: 1 });
    const usW = new Set(wl.us);
    for (const [k, q] of Object.entries(heavy.us.universe?.rows || {})) if (!usW.has(k)) U.push({ k, n: q.n, m: 'us', x: 'US', c: q.c, p: r2(q.p), mc: q.mc, s: q.s || undefined, w: 0 });
    writeJSON(path.join(OUT, 'universe.json'), { date: H.dates?.[nD - 1] || null, tpexDate: heavy.tw.tpex?.date || null, usDate: heavy.us.universe?.date || null, usSrc: heavy.us.universe?.src || null, list: U });
    writeJSON(path.join(OUT, 'universe_hist.json'), series);
    status.universe = `${U.length} 檔`;
  }
  // 市場新聞、熱門題材與相關個股（每次更新都抓；失敗沿用上一次）
  try {
    const U = readJSON(path.join(OUT, 'universe.json'), { list: [] }).list;
    const byKey = Object.fromEntries(U.map(u => [u.k, u]));
    const nm = {};
    for (const u of U) if (u.m === 'tw' && /^\d{4}$/.test(u.k) && u.n && u.n.length >= 2) nm[u.k] = u.n.replace(/\*|-KY$|-創$/g, '');
    const usBig = U.filter(u => u.m === 'us').sort((a, b) => (b.mc || 0) - (a.mc || 0)).slice(0, 150).map(u => u.k).filter(k => k.length >= 3 || wl.us.includes(k));
    for (const k of usBig) nm[k] = k;
    for (const k of wl.us) nm[k] = names[k] || k;
    const YF = require('yahoo-finance2').default;
    const yf = typeof YF === 'function' ? new YF({ suppressNotices: ['yahooSurvey'] }) : YF;
    const dict = readJSON(path.join(ROOT, 'config', 'themes.json'), { themes: [] });
    const watch = [...wl.tw.map(k => ({ key: k, name: names[k] || items[k]?.name || k, market: 'tw' })), ...wl.us.map(k => ({ key: k, name: names[k] || items[k]?.name || k, market: 'us' }))];
    const news = await News.collect({ names: nm, watch, dict, token: TOKEN, yf, log });
    // 題材相關個股加上價格確認：今日漲跌、20 日報酬、站上月線
    for (const t of news.themes) {
      t.stocks = t.stocks.map(s => { const u = byKey[s.key] || {}; return { ...s, name: u.n || items[s.key]?.name || s.key, m: u.m || (/^\d/.test(s.key) ? 'tw' : 'us'), p: u.p ?? items[s.key]?.changePct ?? null, r20: u.r20 ?? null, a20: u.a20 ?? null, w: u.w || 0 }; });
      const ps = t.stocks.map(s => s.p).filter(Number.isFinite);
      t.avgChg = ps.length ? r2(ps.reduce((a, b) => a + b, 0) / ps.length) : null;
      t.heat = Math.round(t.count * 10 + (t.avgChg || 0) * 5 + t.tone * 2);
    }
    news.themes.sort((a, b) => b.heat - a.heat);
    try { const tr = await yf.trendingSymbols('US', { count: 15 }, { validateResult: false }); news.usTrending = (tr.quotes || []).map(q => q.symbol).filter(Boolean); } catch (_) { news.usTrending = []; }
    // 台股成交值排行與漲幅排行（市場實際在追的股票）
    const twU = U.filter(u => u.m === 'tw' && /^\d{4}$/.test(u.k) && Number.isFinite(u.p));
    news.twMovers = twU.filter(u => u.p >= 5).sort((a, b) => b.p - a.p).slice(0, 20).map(u => ({ key: u.k, name: u.n, p: u.p, r20: u.r20 ?? null }));
    // 全球市場快報（可信媒體＋全球行情；AI 摘要每 3 小時或收盤後更新一次）
    let fullStories = [];
    try {
      const Q = await Digest.quotes(yf).catch(e => { log('全球行情失敗', e.message); return []; });
      // Yahoo 偶爾某一檔回空值（例如週末的美元兌台幣）：沿用上一次的報價（t 保留原本的成交時間，網站看得出是舊值）
      { const prevQ = Object.fromEntries((heavy.newsLast?.digest?.quotes || []).filter(q => q.price != null).map(q => [q.sym, q])); for (let i = 0; i < Q.length; i++) if (Q[i].price == null && prevQ[Q[i].sym]) Q[i] = { ...prevQ[Q[i].sym], stale: true }; }
      const stories = await Digest.headlines(log); fullStories = stories;
      const rule = Digest.ruleSummary(Q, stories);
      const dFile = path.join(STATE, 'digest.json');
      let prev = readJSON(dFile, null);
      const hasAI = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
      const recentErr = prev?.lastErrorAt && Date.now() - Date.parse(prev.lastErrorAt) < 30 * 60000;
      if (hasAI && stories.length >= 8 && (FULL || (!recentErr && (!prev?.at || Date.now() - Date.parse(prev.at) > 3 * 3600000)))) {
        try {
          const ai = await Digest.aiSummary(AI.chat, Q, stories);
          prev = { at: new Date().toISOString(), model: AI.chat.last || null, ...ai };  // 成功時清除錯誤紀錄
          writeJSON(dFile, prev); console.log('DIGEST_CHANGED');
          status.digestAI = 'ok ' + (prev.model || '');
        } catch (e) {
          status.digestAI = 'fail: ' + e.message.slice(0, 200);
          // 失敗原因記在狀態檔（原因改變時才存），方便遠端查看
          if (prev?.lastError !== status.digestAI) { prev = { ...(prev || {}), lastError: status.digestAI, lastErrorAt: new Date().toISOString() }; writeJSON(dFile, prev); console.log('DIGEST_CHANGED'); }
        }
      }
      news.digest = { at: new Date().toISOString(), quotes: Q, stories: stories.slice(0, 40).map(({ tk, score, body, alt, ...x }) => x), rule, ai: prev && prev.headline ? prev : null };
      if (FULL && args['archive-daily']) {
        const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
        writeJSON(path.join(path.resolve(String(args['archive-daily'])), 'digest', day.slice(0, 4), `${day}-${fullTW && !fullUS ? 'tw' : fullUS && !fullTW ? 'us' : 'all'}.json`), news.digest);
      }
      status.digest = `${Q.filter(q => q.price != null).length} 項行情／${stories.length} 則事件${news.digest.ai ? '／AI' : ''}`;
    } catch (e) { status.digest = 'fail: ' + e.message.slice(0, 200); }
    // 逐則繁中摘要（有 AI 金鑰時；每小時最多處理一次新新聞，結果快取）
    try {
      const cFile = path.join(STATE, 'newsai.json'), cache = readJSON(cFile, { map: {} });
      try { const tw = await Digest.cnyes('tw_stock', 25); const seenT = new Set(news.market.map(x => x.title.replace(/\s/g, '').slice(0, 30))); news.market = [...tw.filter(x => !seenT.has(x.title.replace(/\s/g, '').slice(0, 30))), ...news.market].sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 50); } catch (e) { log('鉅亨台股新聞失敗', e.message); }
      const groups = [fullStories.slice(0, 40), news.market || [], ...news.themes.map(t => t.news), ...Object.values(news.per).map(l => l.slice(0, 4))];
      const hasAI = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
      let ranAI = false;
      if (hasAI && (!cache.tried || cache.v !== 2 || (cache.lastError && Date.now() - Date.parse(cache.tried) > 30 * 60000) || Date.now() - Date.parse(cache.tried) > 115 * 60000 || FULL)) {
        const r = await NewsAI.summarize(groups.flat(), AI.chat, cache, { log });
        cache.tried = new Date().toISOString(); ranAI = true; cache.v = 2;
        if (process.env.GEMINI_API_KEY && (FULL || !cache.deepAt || Date.now() - Date.parse(cache.deepAt) > 170 * 60000)) { cache.deepAt = new Date().toISOString(); const d = await NewsAI.deepen(fullStories, AI.grounded, cache, { log }); status.newsDeep = d.err ? 'fail: ' + d.err : `查證 ${d.added} 則`; }
        cache.lastError = r.errs[0] || null;
        writeJSON(cFile, cache); console.log('DIGEST_CHANGED');
        status.newsAI = `新增 ${r.added}、待處理 ${r.pending}${r.errs.length ? '、錯誤：' + r.errs[0] : ''}`;
      }
      for (const g of groups) NewsAI.attach(g, cache);
      NewsAI.attach(news.digest?.stories, cache);
      if (ranAI || (hasAI && !cache.themes)) {
        const tr = await NewsAI.themeSummaries(news.themes, AI.chat, cache, { log });
        if (tr.added) { writeJSON(cFile, cache); console.log('DIGEST_CHANGED'); }
        status.themeAI = tr.err ? 'fail: ' + tr.err : `更新 ${tr.added} 個題材`;
      }
      NewsAI.attachThemes(news.themes, cache);
      news.aiSummaries = Object.keys(cache.map || {}).length;
    } catch (e) { status.newsAI = 'fail: ' + e.message.slice(0, 200); }
    for (const n of news.market || []) { delete n.body; delete n.alt; }
    writeJSON(path.join(OUT, 'news.json'), news);
    heavy.newsLast = news;
    status.news = `${news.status.market} 則／題材 ${news.themes.length}／個股 ${news.status.stocks}`;
  } catch (e) {
    status.news = 'fail: ' + e.message.slice(0, 200);
    if (heavy.newsLast) writeJSON(path.join(OUT, 'news.json'), heavy.newsLast);
  }
  // 本次更新各資料來源的狀態（推播用來偵測連續失敗）
  writeJSON(path.join(OUT, 'status.json'), { at: nowIso, mode: FULL ? `full:${FULL}` : 'intraday', status });
  log('輸出完成', OUT);

  // 狀態只在收盤後完整更新時寫入（盤中更新只讀取）
  if (FULL) {
    const signals = Object.fromEntries(Object.values(items).map(x => [x.key, x.signal.sig]));
    const tpeDay = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const fullAt = { ...(last.fullAt || {}) };
    // 只有在收盤後跑的完整更新才算「今天已完成」（盤中手動補跑不影響晚上的排程）
    const tpeHour = new Date(Date.now() + 8 * 3600000).getUTCHours();
    if (fullTW && tpeHour >= 16) fullAt.tw = tpeDay;
    if (fullUS && tpeHour >= 4 && tpeHour < 13) fullAt.us = tpeDay;
    // fullAt 是排程用的「台北日期今天已完成」標記（不能改）；tradeDate 另外記資料實際對應的交易日，方便檢查有沒有斷更
    const twLast = (heavy.tw.hist?.dates || []).slice(-1)[0];
    const tradeDate = { ...(last.tradeDate || {}), ...(twLast ? { tw: `${twLast.slice(0, 4)}-${twLast.slice(4, 6)}-${twLast.slice(6, 8)}` } : {}), ...((heavy.us.valHist || []).length ? { us: heavy.us.valHist[heavy.us.valHist.length - 1].date } : {}) };
    writeJSON(path.join(STATE, 'last.json'), { verdict: { level: verdict.level, at: nowIso }, signals: { ...(last.signals || {}), ...signals }, at: nowIso, status, fullAt, tradeDate });
    writeJSON(path.join(STATE, 'heavy.json'), heavy);
    writeJSON(path.join(STATE, 'conviction.json'), { at: nowIso, conviction, high: Object.values(items).filter(i => i.conv?.high?.length).map(i => ({ key: i.key, bucket: i.conv.bucket, score: i.conv.score, high: i.conv.high })) });
    writeJSON(path.join(STATE, 'predictions.json'), predictions);
    log('狀態已更新', STATE);
  }

  // 每日收盤快照存進 data 分支（GitHub 上永久保存，一天一份，台股收盤後與美股收盤後各覆寫一次）
  if (FULL && args['archive-daily']) {
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const dir = path.resolve(String(args['archive-daily']));
    writeJSON(path.join(dir, day.slice(0, 4), `${day}.json`), snapshot);
    const idx = readJSON(path.join(dir, 'index.json'), { days: [] });
    if (!idx.days.includes(day)) idx.days.push(day);
    idx.days.sort(); idx.updated = nowIso;
    writeJSON(path.join(dir, 'index.json'), idx);
    log('每日快照已存', day);
  }
  if (ARCHIVE) {
    const tpe = new Date(Date.now() + 8 * 3600000).toISOString();
    const day = tpe.slice(0, 10), hm = tpe.slice(11, 16).replace(':', '');
    writeJSON(path.join(ARCHIVE, 'snapshots', day, `${hm}.json`), snapshot);
    writeJSON(path.join(ARCHIVE, 'daily', `${day}.json`), snapshot);
    log('已封存', path.join(ARCHIVE, 'snapshots', day, `${hm}.json`));
  }
  log(`完成，用時 ${snapshot.buildSeconds} 秒`, JSON.stringify(status));
}

main().catch(e => { console.error('[失敗]', e); process.exit(1); });
