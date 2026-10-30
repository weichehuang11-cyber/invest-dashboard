'use strict';
/**
 * 技術解讀 + 走勢推論（指數與個股共用）
 *
 *   解讀：均線排列、MACD、KD、RSI、布林通道、量價、支撐壓力 → 規則化中文評論（描述現況，不是預測）
 *   推論：波動調整的歷史模擬法（filtered historical simulation）
 *         取過去 N 日的「h 日報酬」分布，依目前波動相對長期波動縮放 → 5 日、20 日的 50%／80% 區間與中位數
 *         上漲機率 = 過去處於相同趨勢狀態（多頭／盤整／空頭）時，h 日後上漲的比例
 *   可靠度：滾動回測（每天只用當天以前的資料做推論，再和實際結果比）
 *         → 80% 區間實際涵蓋率、50% 區間涵蓋率、方向命中率，並附「永遠猜漲」的基準
 */

const QS = [0.1, 0.25, 0.5, 0.75, 0.9];
const last = a => a[a.length - 1];
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

function smaSeries(c, n) {
  const out = new Array(c.length).fill(null); let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
function emaSeries(a, n) { const k = 2 / (n + 1), o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(a[i] * k + o[i - 1] * (1 - k)); return o; }
function rsiSeries(c, n = 14) {
  const out = new Array(c.length).fill(null), a = 1 / n; let g = 0, l = 0, den = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1]; g = g * (1 - a) + Math.max(0, d); l = l * (1 - a) + Math.max(0, -d); den = den * (1 - a) + 1;
    if (i >= n) { const ag = g / den, al = l / den; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return out;
}
/** 台股慣用 KD(9,3,3)：RSV → K = 2/3 K + 1/3 RSV，D = 2/3 D + 1/3 K */
function kdSeries(h, l, c, n = 9) {
  const K = [], D = []; let k = 50, d = 50;
  for (let i = 0; i < c.length; i++) {
    const lo = Math.min(...l.slice(Math.max(0, i - n + 1), i + 1)), hi = Math.max(...h.slice(Math.max(0, i - n + 1), i + 1));
    const rsv = hi > lo ? (c[i] - lo) / (hi - lo) * 100 : 50;
    k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3; K.push(k); D.push(d);
  }
  return { K, D };
}
function quantile(sorted, q) { const p = (sorted.length - 1) * q, i = Math.floor(p), f = p - i; return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * f; }
function std(a) { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); }

/** 趨勢狀態：多頭＝收盤 > 60 日線、20 日線 > 60 日線、60 日線較 10 日前上升；空頭相反；其餘盤整 */
function stateAt(c, m20, m60, i) {
  if (m60[i] == null || m60[i - 10] == null) return null;
  if (c[i] > m60[i] && m20[i] > m60[i] && m60[i] > m60[i - 10]) return 'up';
  if (c[i] < m60[i] && m20[i] < m60[i] && m60[i] < m60[i - 10]) return 'down';
  return 'range';
}

/**
 * 在第 t 天（只用 t 以前的資料）推論 h 日後的報酬分布
 * 回傳 log 報酬的分位數與上漲機率
 */
function forecastAt(c, lr, states, t, h, W) {
  const from = Math.max(1, t - W), rs = [], st = states[t];
  let upSame = 0, nSame = 0, upAll = 0;
  for (let k = from; k + h <= t; k++) {
    const r = Math.log(c[k + h] / c[k]); rs.push(r);
    if (r > 0) upAll++;
    if (st && states[k] === st) { nSame++; if (r > 0) upSame++; }
  }
  if (rs.length < 60) return null;
  const dl = lr.slice(Math.max(1, from), t + 1).filter(Number.isFinite);
  const sLong = std(dl), sNow = std(lr.slice(t - 19, t + 1));
  // 目前波動與長期波動各半（避免短期波動一放大就把區間撐太開）
  const scale = sLong > 0 ? Math.min(2.5, Math.max(0.5, Math.sqrt(0.5 * sNow * sNow + 0.5 * sLong * sLong) / sLong)) : 1;
  const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
  const adj = rs.map(r => (r - mean) * scale + mean).sort((a, b) => a - b);
  const upProb = nSame >= 30 ? upSame / nSame : upAll / rs.length;
  return { q: QS.map(q => quantile(adj, q)), upProb, nState: nSame, state: st };
}

function backtest(c, lr, states, h, W, start) {
  let n = 0, in80 = 0, in50 = 0, dirHit = 0, dirN = 0, ups = 0;
  const recs = [];
  for (let t = start; t + h < c.length; t++) {
    const f = forecastAt(c, lr, states, t, h, W); if (!f) continue;
    const r = Math.log(c[t + h] / c[t]);
    n++; recs.push({ q: f.q, p: f.upProb, r });
    if (r >= f.q[0] && r <= f.q[4]) in80++;
    if (r >= f.q[1] && r <= f.q[3]) in50++;
    if (r > 0) ups++;
    if (Math.abs(f.upProb - 0.5) >= 0.02) { dirN++; if ((f.upProb > 0.5) === (r > 0)) dirHit++; }
  }
  if (n < 40) return null;
  return { n, cov80: in80 / n * 100, cov50: in50 / n * 100, dir: dirN ? dirHit / dirN * 100 : null, dirN, base: ups / n * 100, cal: calibrate(recs) };
}

/**
 * 自動校正（用滾動回測的實際結果修正推論）：
 *   區間：找出讓 80%／50% 區間「實際涵蓋率」剛好達標的放大倍數（只用較早的一半挑倍數，再用較新的一半驗證）
 *   上漲機率：依過去「推論機率 → 實際上漲比例」的對照表修正，樣本少時往整體上漲比例收斂
 */
const BINS = [0, 0.4, 0.47, 0.53, 0.6, 1.01];
function covAt(recs, k, lo, hi) {
  let inn = 0;
  for (const x of recs) { const m = x.q[2]; if (x.r >= m - (m - x.q[lo]) * k && x.r <= m + (x.q[hi] - m) * k) inn++; }
  return recs.length ? inn / recs.length : 0;
}
function fitK(recs, target, lo, hi) {
  let best = 1, err = 9;
  for (let k = 0.5; k <= 2.5001; k += 0.05) { const e = Math.abs(covAt(recs, k, lo, hi) - target); if (e < err - 1e-9) { err = e; best = k; } }
  return best;
}
function calibrate(recs) {
  if (recs.length < 80) return null;
  const half = Math.floor(recs.length / 2), old = recs.slice(0, half), neu = recs.slice(half);
  const k80o = fitK(old, 0.8, 0, 4), k50o = fitK(old, 0.5, 1, 3);
  const base = recs.filter(x => x.r > 0).length / recs.length;
  const binOf = p => BINS.findIndex((b, i) => p >= b && p < BINS[i + 1]);
  const table = BINS.slice(0, -1).map(() => ({ n: 0, up: 0 }));
  for (const x of recs) { const b = table[binOf(x.p)]; if (b) { b.n++; if (x.r > 0) b.up++; } }
  const mapP = p => { const b = table[binOf(p)]; return b ? (b.up + 20 * base) / (b.n + 20) : base; };
  // 驗證：用較早一半建的對照表，看較新一半的方向命中率有沒有變好
  const tOld = BINS.slice(0, -1).map(() => ({ n: 0, up: 0 }));
  for (const x of old) { const b = tOld[binOf(x.p)]; if (b) { b.n++; if (x.r > 0) b.up++; } }
  const bOld = old.filter(x => x.r > 0).length / old.length, mapOld = p => { const b = tOld[binOf(p)]; return b ? (b.up + 20 * bOld) / (b.n + 20) : bOld; };
  const hit = (arr, f) => { const a = arr.filter(x => Math.abs(f(x.p) - 0.5) >= 0.02); return a.length ? a.filter(x => (f(x.p) > 0.5) === (x.r > 0)).length / a.length * 100 : null; };
  return {
    k80: +fitK(recs, 0.8, 0, 4).toFixed(2), k50: +fitK(recs, 0.5, 1, 3).toFixed(2),
    oos: { cov80Raw: covAt(neu, 1, 0, 4) * 100, cov80Cal: covAt(neu, k80o, 0, 4) * 100, cov50Raw: covAt(neu, 1, 1, 3) * 100, cov50Cal: covAt(neu, k50o, 1, 3) * 100,
      dirRaw: hit(neu, p => p), dirCal: hit(neu, mapOld), n: neu.length },
    table: table.map((b, i) => ({ from: BINS[i], to: Math.min(1, BINS[i + 1]), n: b.n, up: b.n ? b.up / b.n * 100 : null })),
    mapP,
  };
}

function supportResistance(p, bars, lv) {
  const { high: h, low: l, close: c } = bars;
  const cand = [];
  const add = (v, label) => { if (Number.isFinite(v) && v > 0) cand.push({ p: v, label }); };
  add(lv.ma20, '20 日線'); add(lv.ma60, '60 日線（季線）'); add(lv.ma120, '120 日線（半年線）'); add(lv.ma240, '240 日線（年線）');
  if (c.length > 21) { add(Math.max(...h.slice(-21, -1)), '近 20 日高點'); add(Math.min(...l.slice(-21, -1)), '近 20 日低點'); }
  if (c.length > 61) { add(Math.max(...h.slice(-61, -1)), '近 60 日高點'); add(Math.min(...l.slice(-61, -1)), '近 60 日低點'); }
  if (c.length > 200) { add(Math.max(...h.slice(-252)), '52 週高點'); add(Math.min(...l.slice(-252)), '52 週低點'); }
  add(lv.bbUpper, '布林上軌'); add(lv.bbLower, '布林下軌');
  const pick = (arr) => { const out = []; for (const x of arr) if (!out.some(o => Math.abs(o.p / x.p - 1) < 0.006)) out.push(x); return out.slice(0, 3); };
  return {
    support: pick(cand.filter(x => x.p < p * 0.999).sort((a, b) => b.p - a.p)).map(x => ({ p: r2(x.p, 2), label: x.label, dist: r2((x.p / p - 1) * 100, 1) })),
    resistance: pick(cand.filter(x => x.p > p * 1.001).sort((a, b) => a.p - b.p)).map(x => ({ p: r2(x.p, 2), label: x.label, dist: r2((x.p / p - 1) * 100, 1) })),
  };
}

const STATE_ZH = { up: '多頭', down: '空頭', range: '盤整' };

function analyze(bars, opt = {}) {
  const { close: c, high: h, low: l, volume: v } = bars;
  if (!c || c.length < 130) return null;
  const n = c.length, i = n - 1, p = c[i];
  const W = opt.window || Math.min(750, n - 30);
  const m5 = smaSeries(c, 5), m20 = smaSeries(c, 20), m60 = smaSeries(c, 60), m120 = smaSeries(c, 120), m240 = smaSeries(c, 240);
  const rsi = rsiSeries(c), { K, D } = kdSeries(h, l, c);
  const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26), dif = e12.map((x, k) => x - e26[k]), dea = emaSeries(dif, 9), hist = dif.map((x, k) => x - dea[k]);
  const sd20 = std(c.slice(-20)), bbMid = m20[i], bbUpper = bbMid + 2 * sd20, bbLower = bbMid - 2 * sd20;
  const bw = []; for (let k = Math.max(19, n - 126); k < n; k++) { const s = std(c.slice(k - 19, k + 1)); bw.push(4 * s / m20[k]); }
  const bwPct = bw.filter(x => x <= last(bw)).length / bw.length * 100;
  const lr = c.map((x, k) => (k ? Math.log(x / c[k - 1]) : NaN));
  const states = c.map((_, k) => (k >= 70 ? stateAt(c, m20, m60, k) : null));
  const st = states[i];
  const lv = { ma5: m5[i], ma20: m20[i], ma60: m60[i], ma120: m120[i], ma240: m240[i], bbUpper, bbLower };
  const sr = supportResistance(p, bars, lv);

  // ── 評論（描述現況）────────────────────────────────────────
  const C = [], pos = t => C.push({ tone: 'pos', text: t }), neg = t => C.push({ tone: 'neg', text: t }), neu = t => C.push({ tone: 'neu', text: t });
  const above = [['5 日', m5[i]], ['20 日', m20[i]], ['60 日', m60[i]], ['120 日', m120[i]], ['240 日', m240[i]]].filter(x => x[1] != null);
  const upN = above.filter(x => p > x[1]).length;
  if (upN === above.length) pos(`收盤站上所有均線（5／20／60／120／240 日），${m20[i] > m60[i] && m60[i] > (m120[i] ?? 0) ? '短中長期均線多頭排列' : '均線尚未完全多頭排列'}`);
  else if (upN === 0) neg('收盤跌破所有均線，短中長期均線偏空');
  else neu(`收盤在 ${above.filter(x => p > x[1]).map(x => x[0]).join('、') || '—'}均線之上，${above.filter(x => p <= x[1]).map(x => x[0]).join('、')}均線之下`);
  if (m240[i] != null) { if (p > m240[i] && c[i - 1] <= m240[i - 1]) pos('今天重新站上年線（240 日）'); else if (p < m240[i] && c[i - 1] >= m240[i - 1]) neg('今天跌破年線（240 日），長線轉弱訊號'); }
  if (m60[i] != null) { if (p > m60[i] && c[i - 1] <= m60[i - 1]) pos('今天站回季線（60 日）'); else if (p < m60[i] && c[i - 1] >= m60[i - 1]) neg('今天跌破季線（60 日）'); }
  const slope20 = m20[i - 5] ? (m20[i] / m20[i - 5] - 1) * 100 : null;
  if (slope20 != null) { if (slope20 > 0.8) pos(`20 日線上揚（5 日 +${slope20.toFixed(1)}%），短期趨勢向上`); else if (slope20 < -0.8) neg(`20 日線下彎（5 日 ${slope20.toFixed(1)}%），短期趨勢向下`); }
  if (hist[i] > 0 && hist[i - 1] <= 0) pos('MACD 黃金交叉（快線向上穿越慢線），動能轉強');
  else if (hist[i] < 0 && hist[i - 1] >= 0) neg('MACD 死亡交叉（快線向下穿越慢線），動能轉弱');
  else if (hist[i] > 0 && hist[i] > hist[i - 1] && hist[i - 1] > hist[i - 2]) pos('MACD 柱狀體連續放大，多方動能增強');
  else if (hist[i] < 0 && hist[i] < hist[i - 1] && hist[i - 1] < hist[i - 2]) neg('MACD 柱狀體連續擴大為負，空方動能增強');
  else if (hist[i] > 0 && hist[i] < hist[i - 1]) neu('MACD 仍在零軸上方但柱狀體縮小，漲勢動能減弱');
  else if (hist[i] < 0 && hist[i] > hist[i - 1]) neu('MACD 仍為負但柱狀體縮小，跌勢動能減緩');
  if (K[i] > D[i] && K[i - 1] <= D[i - 1] && K[i] < 30) pos(`KD 在低檔黃金交叉（K ${K[i].toFixed(0)}），短線有反彈機會`);
  else if (K[i] < D[i] && K[i - 1] >= D[i - 1] && K[i] > 70) neg(`KD 在高檔死亡交叉（K ${K[i].toFixed(0)}），短線留意拉回`);
  else if (K[i] > 80) neu(`KD 高檔（K ${K[i].toFixed(0)}），短線過熱但強勢股可能鈍化`);
  else if (K[i] < 20) neu(`KD 低檔（K ${K[i].toFixed(0)}），短線超賣`);
  if (rsi[i] >= 70) neg(`RSI ${rsi[i].toFixed(0)}，進入超買區`); else if (rsi[i] <= 30) pos(`RSI ${rsi[i].toFixed(0)}，進入超賣區`);
  if (p >= bbUpper) neu('收盤觸及布林上軌，強勢但短線乖離大'); else if (p <= bbLower) neu('收盤觸及布林下軌，弱勢但短線乖離大');
  if (bwPct <= 10) neu('布林通道寬度處於近半年最窄的 10%，波動收斂，常醞釀較大的方向突破');
  if (v && v.length > 21 && v[i] > 0) {
    const av = v.slice(-21, -1).reduce((s, x) => s + x, 0) / 20, rv = av > 0 ? v[i] / av : null, ch = (p / c[i - 1] - 1) * 100;
    if (rv >= 1.5 && ch > 0.5) pos(`價漲量增（成交量為 20 日均量 ${rv.toFixed(1)} 倍）`);
    else if (rv >= 1.5 && ch < -0.5) neg(`價跌量增（成交量為 20 日均量 ${rv.toFixed(1)} 倍），賣壓明顯`);
    else if (rv != null && rv < 0.6 && Math.abs(ch) < 0.5) neu('量縮整理');
  }
  if (c.length > 252 && p >= Math.max(...c.slice(-252))) pos('收盤創 52 週新高');
  else if (c.length > 252 && p <= Math.min(...c.slice(-252))) neg('收盤創 52 週新低');
  if (sr.support[0]) neu(`最近支撐：${sr.support[0].label} ${sr.support[0].p}（${sr.support[0].dist}%）`);
  if (sr.resistance[0]) neu(`最近壓力：${sr.resistance[0].label} ${sr.resistance[0].p}（+${sr.resistance[0].dist}%）`);

  const posN = C.filter(x => x.tone === 'pos').length, negN = C.filter(x => x.tone === 'neg').length;
  const trendText = st === 'up' ? '多頭格局：收盤在季線之上，20 日線高於季線且季線上揚'
    : st === 'down' ? '空頭格局：收盤在季線之下，20 日線低於季線且季線下彎'
    : '盤整格局：均線方向不一致，趨勢不明確';

  // ── 推論與回測 ──────────────────────────────────────────────
  const start = Math.max(130, n - (opt.backtestDays || 750));
  const fc = {}, rel = {};
  const ks = {};
  const adjQ = (q, cal) => { if (!cal) return q; const m = q[2]; return [m - (m - q[0]) * cal.k80, m - (m - q[1]) * cal.k50, m, m + (q[3] - m) * cal.k50, m + (q[4] - m) * cal.k80]; };
  for (const hz of [5, 20]) {
    const b = backtest(c, lr, states, hz, W, start), cal = b?.cal || null; ks[hz] = cal;
    const f = forecastAt(c, lr, states, i, hz, W);
    if (f) { const q = adjQ(f.q, cal), up = cal ? cal.mapP(f.upProb) : f.upProb;
      fc['h' + hz] = { q: q.map(x => r2(p * Math.exp(x), 2)), qPct: q.map(x => r2((Math.exp(x) - 1) * 100, 2)), upProb: r2(up * 100, 0), upRaw: r2(f.upProb * 100, 0), nState: f.nState, calibrated: !!cal }; }
    rel['h' + hz] = b && { n: b.n, cov80: r2(b.cov80, 0), cov50: r2(b.cov50, 0), dir: r2(b.dir, 0), dirN: b.dirN, base: r2(b.base, 0),
      cal: cal && { k80: cal.k80, k50: cal.k50, cov80Cal: r2(cal.oos.cov80Cal, 0), cov50Cal: r2(cal.oos.cov50Cal, 0), cov80Raw: r2(cal.oos.cov80Raw, 0), cov50Raw: r2(cal.oos.cov50Raw, 0), dirRaw: r2(cal.oos.dirRaw, 0), dirCal: r2(cal.oos.dirCal, 0), oosN: cal.oos.n,
        table: cal.table.map(t => ({ from: Math.round(t.from * 100), to: Math.round(t.to * 100), n: t.n, up: r2(t.up, 0) })) } };
  }
  const cone = [];
  for (let d = 1; d <= 20; d++) { const f = forecastAt(c, lr, states, i, d, W); if (f) cone.push(adjQ(f.q, d <= 10 ? ks[5] : ks[20]).map(x => r2(p * Math.exp(x), 2))); }

  return {
    state: st, stateZh: STATE_ZH[st] || '—', trendText, posN, negN,
    levels: Object.fromEntries(Object.entries(lv).map(([k, x]) => [k, r2(x, 2)])),
    ind: { rsi: r2(rsi[i], 1), k: r2(K[i], 1), d: r2(D[i], 1), dif: r2(dif[i], 3), dea: r2(dea[i], 3), hist: r2(hist[i], 3), bbWidthPct: r2(bwPct, 0) },
    sr, comments: C, forecast: fc, reliability: rel, cone,
    method: '波動調整歷史模擬：取過去約 3 年（個股約 1 年）的 h 日報酬分布，依目前波動縮放；上漲機率取過去相同趨勢狀態的實際比例。可靠度為滾動回測（只用當時以前的資料）；區間寬度與上漲機率依回測的實際結果自動校正。',
  };
}

module.exports = { analyze, kdSeries, rsiSeries, smaSeries };
