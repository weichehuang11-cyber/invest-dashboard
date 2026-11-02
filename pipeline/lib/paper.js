'use strict';
/**
 * 虛擬跟單：照系統訊號用假錢買賣，記錄每一筆，再用結果回頭檢驗、校正規則
 *
 * 規則（每個市場兩本帳）：
 *   原始（base）── 完全照網站訊號：當天收盤出現「買進」→ 隔天開盤買（台股 500 股、美股 5 股，訊號持續就每天加碼）；
 *                  出現「賣出」或收盤跌破移動停損（進場後最高的「收盤 − 2×ATR」）→ 隔天開盤全部賣出
 *   校正（tuned）── 同樣的流程，但買進門檻、賣出門檻、停損倍數用「回測校正」挑出來的參數
 * 成本：台股手續費 0.1425%（最低 1 元）、賣出證交稅 0.3%（ETF 0.1%）；美股不計手續費
 *
 * 校正：用觀察清單過去 5 年的技術分數（與網站相同公式）模擬同一套流程，
 *   參數組合在前 60% 期間挑最好的，再到後 40% 驗證；後段也贏過目前參數、而且超額報酬為正，才換上。
 */
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const SHARES = { tw: 500, us: 5 };
const DEFAULT = { buyTh: null, sellTh: 37, stopK: 2 };   // buyTh null＝跟網站的買進門檻（會隨 VIX 調整）

function fees(m, key, side, amt) {
  if (m !== 'tw') return 0;
  const fee = Math.max(1, Math.round(amt * 0.001425));
  const tax = side === 'sell' ? Math.round(amt * (/^00/.test(key) ? 0.001 : 0.003)) : 0;
  return fee + tax;
}

function atrSeries(b, n = 14) {
  const { high: h, low: l, close: c } = b, out = new Array(c.length).fill(null); let a = null;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    a = a == null ? tr : (a * (n - 1) + tr) / n; if (i >= n) out[i] = a;
  }
  return out;
}

const emptyBook = () => ({ lots: [], pending: [], trades: [], equity: [], realized: 0, fees: 0 });

/**
 * 每次收盤後的完整更新呼叫一次（同一個交易日重跑不會重複下單）
 * @param st      state/paper.json 的內容
 * @param m       'tw' | 'us'
 * @param items   觀察清單（snapshot.items 中這個市場的）
 * @param daily   key → { bars }
 * @param bench   大盤日 K bars（算超額報酬）
 */
function step(st, m, items, daily, bench, siteP) {
  st.v = 1; st.start = st.start || {}; st.mk = st.mk || {}; st.params = st.params || {}; st.sig = st.sig || {};
  const M = st.mk[m] = st.mk[m] || { base: emptyBook(), tuned: emptyBook(), lastDay: null };
  const list = Object.values(items).filter(i => i.market === m && i.marketDate && daily[i.key]?.bars);
  if (!list.length) return null;
  const day = list.map(i => i.marketDate).sort().pop();
  if (M.lastDay === day) return null;   // 這個交易日已經處理過
  st.start[m] = st.start[m] || day;
  const P = { base: { ...DEFAULT, ...(siteP?.stopK != null ? { stopK: siteP.stopK } : {}) }, tuned: { ...DEFAULT, ...(st.params[m] || {}) } };
  const at = (k, d) => { const b = daily[k].bars, i = b.dates.lastIndexOf(d); return i < 0 ? null : { o: b.open[i], c: b.close[i], i }; };

  for (const [name, B] of Object.entries({ base: M.base, tuned: M.tuned })) {
    const prm = P[name];
    // 1. 上一個交易日掛的單，用今天開盤價成交
    const keep = [];
    for (const o of B.pending) {
      const q = at(o.k, day);
      if (!q || o.d >= day) { keep.push(o); continue; }
      const px = q.o > 0 ? q.o : q.c;
      if (o.side === 'buy') {
        const amt = px * o.sh, f = fees(m, o.k, 'buy', amt);
        B.lots.push({ k: o.k, sd: o.d, fd: day, px: r2(px, 4), sh: o.sh, fee: f, stop: o.stop ?? null }); B.fees += f;
      } else {
        const lots = B.lots.filter(l => l.k === o.k); if (!lots.length) continue;
        B.lots = B.lots.filter(l => l.k !== o.k);
        const sh = lots.reduce((a, l) => a + l.sh, 0), cost = lots.reduce((a, l) => a + l.px * l.sh + l.fee, 0);
        const amt = px * sh, f = fees(m, o.k, 'sell', amt), pnl = amt - f - cost;
        const bd = lots[0].fd, br = benchRet(bench, bd, day);
        B.trades.push({ k: o.k, bd, sd: day, sh, bp: r2(cost / sh, 4), spx: r2(px, 4), pnl: r2(pnl, 2), ret: r2(pnl / cost * 100, 2), ex: br == null ? null : r2(pnl / cost * 100 - br, 2), why: o.why });
        B.realized += pnl; B.fees += f;
      }
    }
    B.pending = keep;
    // 2. 今天收盤的訊號 → 明天開盤的單
    for (const it of list) {
      if (it.marketDate !== day) continue;
      const g = it.signal || {}, sc = g.score, held = B.lots.some(l => l.k === it.key);
      const buyTh = prm.buyTh ?? g.buyThreshold ?? 63;
      const isBuy = name === 'base' ? g.sig === 'BUY' : sc >= buyTh;
      const isSell = name === 'base' ? g.sig === 'SELL' : sc <= prm.sellTh;
      // 移動停損：進場後「收盤 − k×ATR」的最高值
      const atr = it.ta?.atr, trail = prm.stopK && atr ? it.price - prm.stopK * atr : null;
      let stopHit = false;
      if (held) for (const l of B.lots.filter(x => x.k === it.key)) { if (l.stop != null && it.price < l.stop) stopHit = true; if (trail != null) l.stop = Math.max(l.stop ?? -Infinity, r2(trail, 4)); }
      if (held && (isSell || stopHit) && !B.pending.some(o => o.k === it.key && o.side === 'sell')) B.pending.push({ k: it.key, side: 'sell', d: day, why: isSell ? '賣出訊號' : '跌破停損' });
      else if (isBuy && !isSell && !stopHit) B.pending.push({ k: it.key, side: 'buy', d: day, sh: SHARES[m], stop: trail != null ? r2(trail, 4) : null });
    }
    // 3. 今天收盤的帳面
    let cost = 0, mv = 0;
    for (const l of B.lots) { const q = at(l.k, day); cost += l.px * l.sh + l.fee; mv += (q ? q.c : l.px) * l.sh; }
    B.equity.push({ d: day, cost: r2(cost, 0), mv: r2(mv, 0), real: r2(B.realized, 0) });
    if (B.equity.length > 800) B.equity.shift();
    if (B.trades.length > 2000) B.trades.splice(0, B.trades.length - 2000);
  }
  // 4. 訊號紀錄（之後用真實走勢對答案）
  const S = st.sig[m] = st.sig[m] || [];
  for (const it of list) if (it.marketDate === day && it.signal) S.push({ k: it.key, d: day, p: it.price, s: it.signal.sig, sc: it.signal.score });
  if (S.length > 20000) S.splice(0, S.length - 20000);
  M.lastDay = day;
  return day;
}

function benchRet(bench, d0, d1) {
  if (!bench) return null;
  const i0 = bench.dates.findIndex(x => x >= d0), i1 = bench.dates.findLastIndex(x => x <= d1);
  return i0 < 0 || i1 < 0 || i1 <= i0 ? null : (bench.close[i1] / bench.close[i0] - 1) * 100;
}

/** 訊號對答案：買進／賣出訊號之後 5、20 個交易日的實際漲跌與贏不贏大盤（依分數分組） */
function accuracy(st, m, daily, bench) {
  const S = st.sig?.[m] || [], groups = {};
  const G = (s, sc) => (s === 'BUY' ? (sc >= 75 ? '買進・分數 75+' : sc >= 68 ? '買進・分數 68–74' : '買進・分數 ≤67') : s === 'SELL' ? '賣出' : null);
  for (const x of S) {
    const g = G(x.s, x.sc); if (!g) continue;
    const b = daily[x.k]?.bars; if (!b) continue;
    const i = b.dates.indexOf(x.d); if (i < 0) continue;
    const R = groups[g] = groups[g] || { n: 0, h5: [], h20: [] };
    R.n++;
    for (const h of [5, 20]) {
      if (i + h >= b.close.length) continue;
      const ret = (b.close[i + h] / b.close[i] - 1) * 100, br = benchRet(bench, b.dates[i], b.dates[i + h]);
      R['h' + h].push({ ret, ex: br == null ? null : ret - br });
    }
  }
  const sum = (a, dir) => {
    if (!a.length) return null;
    const ex = a.filter(x => x.ex != null);
    return { n: a.length, hit: r2(a.filter(x => (dir > 0 ? x.ret > 0 : x.ret < 0)).length / a.length * 100, 0), avg: r2(a.reduce((s, x) => s + x.ret, 0) / a.length, 2),
      beat: ex.length ? r2(ex.filter(x => (dir > 0 ? x.ex > 0 : x.ex < 0)).length / ex.length * 100, 0) : null, exAvg: ex.length ? r2(ex.reduce((s, x) => s + x.ex, 0) / ex.length, 2) : null };
  };
  return Object.fromEntries(Object.entries(groups).map(([g, R]) => { const dir = g === '賣出' ? -1 : 1; return [g, { n: R.n, h5: sum(R.h5, dir), h20: sum(R.h20, dir) }]; }));
}

// ── 回測校正 ────────────────────────────────────────────────
/**
 * 用技術分數序列模擬：分數 ≥ buyTh 隔天開盤買（每天加碼），分數 ≤ sellTh 或跌破移動停損隔天開盤全賣
 * 回傳每一筆交易（含超額報酬）
 */
function simulate(stocks, bench, prm, from, to) {
  const out = [];
  for (const s of stocks) {
    const { b, ta, atr } = s, c = b.close, o = b.open; let lots = [], stop = null, pendBuy = false, pendSell = false;
    for (let i = 1; i < c.length; i++) {
      const d = b.dates[i];
      if (d < from || d > to) { if (d > to && lots.length) { close(i, '期末'); } continue; }
      const px = o[i] > 0 ? o[i] : c[i];
      if (pendSell && lots.length) close(i, '賣出');
      if (pendBuy) lots.push({ i, px, sh: 1 });
      pendBuy = pendSell = false;
      if (ta[i] == null) continue;
      const trail = prm.stopK && atr[i] ? c[i] - prm.stopK * atr[i] : null;
      const hit = lots.length && stop != null && c[i] < stop;
      if (trail != null && lots.length) stop = Math.max(stop ?? -Infinity, trail);
      if (lots.length && (ta[i] <= prm.sellTh || hit)) pendSell = true;
      else if (ta[i] >= prm.buyTh) { pendBuy = true; if (!lots.length) stop = trail; }
    }
    if (lots.length) close(c.length - 1, '期末', true);
    function close(i, why, atClose) {
      const px = atClose ? c[i] : (o[i] > 0 ? o[i] : c[i]), cost = lots.reduce((a, l) => a + l.px * l.sh, 0), sh = lots.reduce((a, l) => a + l.sh, 0);
      const ret = (px * sh / cost - 1) * 100 - 0.585;   // 台股來回成本約 0.585%（美股略高估，影響不大）
      const br = benchRet(bench, b.dates[lots[0].i], b.dates[i]);
      out.push({ k: s.key, ret, ex: br == null ? null : ret - br, days: i - lots[0].i, why });
      lots = []; stop = null;
    }
  }
  return out;
}
function metric(tr) {
  const ex = tr.filter(x => x.ex != null);
  if (!tr.length) return { n: 0, score: -Infinity };
  const exAvg = ex.reduce((a, x) => a + x.ex, 0) / Math.max(1, ex.length);
  const sd = Math.sqrt(ex.reduce((a, x) => a + (x.ex - exAvg) ** 2, 0) / Math.max(1, ex.length - 1)) || 1;
  return { n: tr.length, win: r2(tr.filter(x => x.ret > 0).length / tr.length * 100, 0), avg: r2(tr.reduce((a, x) => a + x.ret, 0) / tr.length, 2), exAvg: r2(exAvg, 2),
    beat: r2(ex.filter(x => x.ex > 0).length / Math.max(1, ex.length) * 100, 0), days: Math.round(tr.reduce((a, x) => a + x.days, 0) / tr.length), score: tr.length < 15 ? -Infinity : exAvg / sd * Math.sqrt(ex.length) };
}
/**
 * @param stocks [{ key, b: bars }]   觀察清單（同一市場）
 * @param taOf   bars → 技術分數序列（與網站相同公式）
 */
function tune(stocks, bench, taOf, cur) {
  const S = stocks.filter(s => s.b?.close?.length > 300).map(s => ({ key: s.key, b: s.b, ta: taOf(s.b), atr: atrSeries(s.b) }));
  if (!S.length) return null;
  const dates = [...new Set(S.flatMap(s => s.b.dates))].sort();
  const start = dates[Math.floor(dates.length * 0.1)], cut = dates[Math.floor(dates.length * 0.64)], end = dates[dates.length - 1];
  const base = { buyTh: 63, sellTh: 37, stopK: 2 }, curP = { ...base, ...(cur || {}) }; if (curP.buyTh == null) curP.buyTh = 63;
  const grid = [];
  for (const buyTh of [55, 58, 60, 63, 66, 70, 75]) for (const sellTh of [37, 42, 47]) for (const stopK of [0, 2, 3]) if (sellTh < buyTh - 5) grid.push({ buyTh, sellTh, stopK });
  const rows = grid.map(p => ({ p, train: metric(simulate(S, bench, p, start, cut)), test: metric(simulate(S, bench, p, cut, end)) }));
  const ok = rows.filter(r => Number.isFinite(r.train.score)).sort((a, b) => b.train.score - a.train.score);
  const best = ok[0];
  const ref = rows.find(r => r.p.buyTh === curP.buyTh && r.p.sellTh === curP.sellTh && r.p.stopK === curP.stopK) || { p: curP, train: metric(simulate(S, bench, curP, start, cut)), test: metric(simulate(S, bench, curP, cut, end)) };
  const orig = rows.find(r => r.p.buyTh === 63 && r.p.sellTh === 37 && r.p.stopK === 2);
  const adopt = !!(best && Number.isFinite(best.test.score) && best.test.score > (Number.isFinite(ref.test.score) ? ref.test.score : -Infinity) && best.test.exAvg > 0);
  const pick = adopt ? best.p : ref.p;
  const view = r => r && { p: r.p, train: { ...r.train, score: undefined }, test: { ...r.test, score: undefined } };
  return {
    at: new Date().toISOString(), period: { start, cut, end }, stocks: S.length, adopt, params: pick,
    best: view(best), current: view(ref), original: view(orig),
    top: ok.slice(0, 5).map(view),
  };
}

/** 給網站的摘要（不含完整紀錄） */
function summary(st, m, items, daily, bench) {
  const M = st.mk?.[m]; if (!M) return null;
  const book = B => {
    const pos = {}; for (const l of B.lots) { const p = pos[l.k] = pos[l.k] || { k: l.k, sh: 0, cost: 0, since: l.fd, stop: l.stop }; p.sh += l.sh; p.cost += l.px * l.sh + l.fee; p.stop = l.stop ?? p.stop; }
    let mv = 0, cost = 0;
    const open = Object.values(pos).map(p => { const it = items[p.k], px = it?.price ?? null, v = px != null ? px * p.sh : p.cost; mv += v; cost += p.cost; return { k: p.k, name: it?.name || p.k, sh: p.sh, avg: r2(p.cost / p.sh, 2), px, mv: r2(v, 0), pnl: r2(v - p.cost, 0), ret: r2((v / p.cost - 1) * 100, 2), since: p.since, stop: r2(p.stop, 2) }; }).sort((a, b) => b.mv - a.mv);
    const T = B.trades, wins = T.filter(t => t.pnl > 0), ex = T.filter(t => t.ex != null);
    const eq = B.equity.slice(-260).map(e => ({ d: e.d, pnl: r2(e.mv - e.cost + e.real, 0), cost: e.cost }));
    return { open, cost: r2(cost, 0), mv: r2(mv, 0), unreal: r2(mv - cost, 0), realized: r2(B.realized, 0), fees: r2(B.fees, 0), total: r2(mv - cost + B.realized, 0),
      closed: T.length, win: T.length ? r2(wins.length / T.length * 100, 0) : null, avgRet: T.length ? r2(T.reduce((a, t) => a + t.ret, 0) / T.length, 2) : null,
      beat: ex.length ? r2(ex.filter(t => t.ex > 0).length / ex.length * 100, 0) : null, exAvg: ex.length ? r2(ex.reduce((a, t) => a + t.ex, 0) / ex.length, 2) : null,
      trades: T.slice(-15).reverse().map(t => ({ ...t, name: items[t.k]?.name || t.k })), pending: B.pending.map(o => ({ k: o.k, side: o.side, sh: o.sh || null, why: o.why || null })), equity: eq };
  };
  return { since: st.start?.[m] || null, lastDay: M.lastDay, shares: SHARES[m], base: book(M.base), tuned: book(M.tuned), params: { ...DEFAULT, ...(st.params?.[m] || {}) }, tune: st.tune?.[m] || null, accuracy: accuracy(st, m, daily, bench) };
}

module.exports = { step, tune, summary, accuracy, simulate, metric, DEFAULT, SHARES };
