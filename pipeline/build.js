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
const INDEX = { '^GSPC': '標普 500', '^IXIC': '那斯達克', '^TWII': '加權指數', 'USDTWD=X': '美元兌台幣', 'DX-Y.NYB': '美元指數' };

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
  const keys = [...wl.us, ...wl.tw, ...Object.keys(INDEX), ...Object.keys(SECTORS)];
  const daily = {};
  await mapSeries(keys, async k => { const d = await Yahoo.daily(k); if (d) daily[k] = d; }, 300);
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
    heavy.tw.ts = Date.now();
  }

  // ── 3b. 美股收盤後：基本面、財報日 ──────────────────────────────
  if (fullUS) {
    try {
      const YF = require('yahoo-finance2').default;
      const yf = typeof YF === 'function' ? new YF({ suppressNotices: ['yahooSurvey'] }) : YF;
      heavy.us.fund = heavy.us.fund || {};
      await mapSeries(wl.us, async s => {
        const q = await yf.quoteSummary(s, { modules: ['financialData', 'calendarEvents', 'summaryDetail', 'defaultKeyStatistics'] }, { validateResult: false });
        const fd = q.financialData || {}, sd = q.summaryDetail || {}, ks = q.defaultKeyStatistics || {};
        const ed = q.calendarEvents?.earnings?.earningsDate?.[0];
        heavy.us.fund[s] = {
          recommendationMean: fd.recommendationMean ?? null, recommendation: fd.recommendationKey ?? null,
          targetPrice: fd.targetMeanPrice ?? null, revenueGrowth: fd.revenueGrowth != null ? fd.revenueGrowth * 100 : null,
          grossMargin: fd.grossMargins != null ? fd.grossMargins * 100 : null,
          pe: sd.trailingPE ?? null, forwardPE: sd.forwardPE ?? ks.forwardPE ?? null, eps: ks.trailingEps ?? null,
          dividendYield: sd.dividendYield != null ? sd.dividendYield * 100 : null,
          earningsDate: ed ? new Date(ed).toISOString().slice(0, 10) : null,
        };
      }, 600);
      status.fundamentals = `${Object.keys(heavy.us.fund).length}/${wl.us.length}`;
    } catch (e) { status.fundamentals = 'fail: ' + e.message; }
    heavy.us.ts = Date.now();
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
    items[key] = {
      key, market, name: names[key] || d.name || key, currency: d.currency,
      price: r2(d.price, 4), prevClose: r2(d.prevClose, 4), changePct: r2(d.changePct), marketDate: d.marketDate, marketTime: d.marketTime,
      ta: ta && Object.fromEntries(Object.entries(ta).map(([k, v]) => [k, typeof v === 'number' ? r2(v, 4) : v])),
      chip, fund, ml, signal: { ...sig, stop: ta?.stopLong ? r2(ta.stopLong, 2) : null },
    };
  }
  log('個股完成', Object.keys(items).length);

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
  const verdict = Verdict.build({ vix, spx: spx && { ...spx }, twii, foreign, curve }, last.verdict);

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
    if (it.changePct != null && Math.abs(it.changePct) >= 4) {
      changes.push({ tag: '價格', sev: 2, key: it.key, title: `${it.key} ${it.name} ${it.changePct > 0 ? '大漲' : '大跌'} ${Math.abs(it.changePct).toFixed(1)}%`, detail: it.ta?.relVolume ? `成交量為 20 日均量的 ${it.ta.relVolume.toFixed(1)} 倍` : '' });
    }
  }
  if (vix?.prevClose != null) for (const lv of [20, 25, 30]) {
    if (vix.prevClose < lv && vix.price >= lv) changes.push({ tag: '市場', sev: 2, title: `VIX 恐慌指數升破 ${lv}`, detail: `買進門檻自動提高至 ${Signal.buyThreshold(vix.price)} 分` });
    if (vix.prevClose >= lv && vix.price < lv) changes.push({ tag: '市場', sev: 1, title: `VIX 恐慌指數回落到 ${lv} 以下`, detail: `買進門檻 ${Signal.buyThreshold(vix.price)} 分` });
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
    note: '收盤後記錄買進／賣出訊號，依之後第 N 個交易日收盤判定；漲跌未達 ±0.5% 不計入。',
  };

  // ── 8. 輸出 ────────────────────────────────────────────────────
  const ranking = Object.values(items).sort((a, b) => b.signal.score - a.signal.score).map(x => x.key);
  const snapshot = {
    version: 1, generatedAt: nowIso, mode: FULL ? `full:${FULL}` : 'intraday', buildSeconds: Math.round((Date.now() - t0) / 1000),
    status, verdict, env, items, ranking, changes, sectors, scorecard,
    chipMarket: heavy.tw.chipMarket || null,
    watchlist: { us: wl.us, tw: wl.tw },
  };
  writeJSON(path.join(OUT, 'snapshot.json'), snapshot);
  for (const key of Object.keys(items)) {
    const d = daily[key];
    const n = 260, sl = a => a.slice(-n);
    writeJSON(path.join(OUT, 'bars', `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), {
      key, dates: sl(d.bars.dates), open: sl(d.bars.open).map(v => r2(v, 4)), high: sl(d.bars.high).map(v => r2(v, 4)),
      low: sl(d.bars.low).map(v => r2(v, 4)), close: sl(d.bars.close).map(v => r2(v, 4)), volume: sl(d.bars.volume),
      chipHistory: heavy.tw.finmind?.[key]?.hist?.slice(-40) || null,
      predictions: predictions.filter(p => p.key === key).slice(-15),
    });
  }
  log('輸出完成', OUT);

  // 狀態只在收盤後完整更新時寫入（盤中更新只讀取）
  if (FULL) {
    const signals = Object.fromEntries(Object.values(items).map(x => [x.key, x.signal.sig]));
    writeJSON(path.join(STATE, 'last.json'), { verdict: { level: verdict.level, at: nowIso }, signals: { ...(last.signals || {}), ...signals }, at: nowIso });
    writeJSON(path.join(STATE, 'heavy.json'), heavy);
    writeJSON(path.join(STATE, 'predictions.json'), predictions);
    log('狀態已更新', STATE);
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
