'use strict';
/**
 * 高信心訊號（只用價格資料，可以誠實回測 5 年）
 *
 *   信心分數 = 偏多條件數 − 偏空條件數（−6 ～ +6），六個條件固定、不做最佳化：
 *     1. 技術分數（與系統相同公式）≥ 63 ／ ≤ 37
 *     2. 趨勢狀態：多頭 ／ 空頭（收盤與 20、60 日線排列，60 日線方向）
 *     3. 相對強弱：近 20 日報酬 贏 ／ 輸 大盤
 *     4. 中期動能：近 60 日報酬 > 0 ／ < 0
 *     5. 收盤 在 ／ 不在 20 日線之上
 *     6. RSI 在 50–70 健康上漲區 ／ 30–50 弱勢區
 *
 *   預測目標（第 2 項建議：預測「贏不贏大盤」比預測漲跌容易）：
 *     ex5  未來 5 個交易日贏大盤
 *     ex20 未來 20 個交易日贏大盤
 *     up20 未來 20 個交易日上漲
 *
 *   驗證：依時間切分，前 60% 為「建立期」、後 40% 為「驗證期」；每 5 個交易日取一次樣本降低重疊。
 *   只有驗證期命中率 ≥ 65%、樣本 ≥ 40，而且建立期也 ≥ 60% 的分組，才會被標成「高信心」。
 */

function series(b) {
  const c = b.close, h = b.high, l = b.low, v = b.volume, n = c.length;
  const ema = (a, k) => { const q = 2 / (k + 1), o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(a[i] * q + o[i - 1] * (1 - q)); return o; };
  const sma = k => { const o = new Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { s += c[i]; if (i >= k) s -= c[i - k]; if (i >= k - 1) o[i] = s / k; } return o; };
  const e12 = ema(c, 12), e26 = ema(c, 26), m20 = sma(20), m60 = sma(60);
  const rsi = new Array(n).fill(null); { const a = 1 / 14; let g = 0, ls = 0, den = 0; for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1]; g = g * (1 - a) + Math.max(0, d); ls = ls * (1 - a) + Math.max(0, -d); den = den * (1 - a) + 1; if (i >= 14) { const ag = g / den, al = ls / den; rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } } }
  const ta = new Array(n).fill(null);
  for (let i = 61; i < n; i++) {
    const chg = (c[i] / c[i - 1] - 1) * 100;
    let sd = 0; for (let j = i - 19; j <= i; j++) sd += (c[j] - m20[i]) ** 2; sd = Math.sqrt(sd / 19);
    const bb = sd > 0 ? (c[i] - (m20[i] - 2 * sd)) / (4 * sd) * 100 : 50;
    let av = 0; for (let j = i - 20; j < i; j++) av += v?.[j] || 0; av /= 20;
    const rv = av > 0 ? (v[i] || 0) / av : null;
    let s = 50 + Math.max(-10, Math.min(10, chg));
    if (rsi[i] != null) s += (50 - rsi[i]) * 0.25;
    s += (e12[i] - e26[i]) / c[i] * 100 * 8;
    s += (50 - bb) * 0.10;
    s += c[i] > m20[i] ? 4 : -4;
    s += m20[i] > m60[i] ? 3 : -3;
    if (rv > 2) s += chg > 0 ? 4 : chg < 0 ? -4 : 0;
    if (rsi[i] < 30) s += 5; if (rsi[i] > 70) s -= 5;
    ta[i] = Math.max(5, Math.min(95, s));
  }
  return { c, m20, m60, rsi, ta };
}

/** 每天的信心分數與條件明細（需要對齊大盤） */
function score(b, bench) {
  const S = series(b), n = b.close.length;
  const bm = new Map(bench.dates.map((d, i) => [d, bench.close[i]]));
  const bc = b.dates.map(d => bm.get(d) ?? null);
  for (let i = 1; i < n; i++) if (bc[i] == null) bc[i] = bc[i - 1];
  // 大盤環境：大盤收盤在 200 日線之上＝多頭，否則＝空頭
  const reg = new Array(n).fill(null); { let s = 0, k = 0; const q = []; for (let i = 0; i < n; i++) { const v = bc[i]; if (v == null) continue; q.push(v); s += v; if (q.length > 200) s -= q.shift(); if (q.length === 200) reg[i] = v > s / 200 ? 'bull' : 'bear'; } }
  const out = new Array(n).fill(null);
  for (let i = 80; i < n; i++) {
    const c = S.c, r20 = c[i] / c[i - 20] - 1, b20 = bc[i] && bc[i - 20] ? bc[i] / bc[i - 20] - 1 : null, r60 = c[i] / c[i - 60] - 1;
    const st = c[i] > S.m60[i] && S.m20[i] > S.m60[i] && S.m60[i] > S.m60[i - 10] ? 1 : c[i] < S.m60[i] && S.m20[i] < S.m60[i] && S.m60[i] < S.m60[i - 10] ? -1 : 0;
    const items = [
      ['技術分數', S.ta[i] >= 63 ? 1 : S.ta[i] <= 37 ? -1 : 0, `技術分數 ${Math.round(S.ta[i])}`],
      ['趨勢', st, st > 0 ? '多頭排列' : st < 0 ? '空頭排列' : '盤整'],
      ['相對強弱', b20 == null ? 0 : r20 > b20 ? 1 : -1, b20 == null ? '無大盤資料' : `近 20 日 ${(r20 * 100).toFixed(1)}%，大盤 ${(b20 * 100).toFixed(1)}%`],
      ['中期動能', r60 > 0 ? 1 : -1, `近 60 日 ${(r60 * 100).toFixed(1)}%`],
      ['20 日線', c[i] > S.m20[i] ? 1 : -1, c[i] > S.m20[i] ? '收盤在 20 日線之上' : '收盤在 20 日線之下'],
      ['RSI', S.rsi[i] >= 50 && S.rsi[i] <= 70 ? 1 : S.rsi[i] >= 30 && S.rsi[i] < 50 ? -1 : 0, `RSI ${Math.round(S.rsi[i])}`],
    ];
    out[i] = { date: b.dates[i], score: items.reduce((s, x) => s + x[1], 0), items, regime: reg[i] };
  }
  return { scores: out, bc, regime: reg };
}

const BUCKETS = [['強烈偏多', s => s >= 5], ['偏多', s => s >= 3 && s <= 4], ['中性', s => s >= -2 && s <= 2], ['偏空', s => s <= -3 && s >= -4], ['強烈偏空', s => s <= -5]];
const bucketOf = s => (BUCKETS.find(([, f]) => f(s)) || ['中性'])[0];

/**
 * 回測：所有標的、每 5 個交易日一次樣本
 * 偏多分組：命中＝贏大盤（或上漲）；偏空分組：命中＝輸大盤（或下跌）
 */
function evaluate(list, step = 5) {
  const rows = [];
  for (const { b, sc } of list) {
    const { scores, bc } = sc, c = b.close;
    for (let i = 80; i + 20 < c.length; i += step) {
      const s = scores[i]; if (!s) continue;
      const ex = k => (bc[i] && bc[i + k] ? (c[i + k] / c[i] - 1) - (bc[i + k] / bc[i] - 1) : null);
      rows.push({ date: b.dates[i], score: s.score, regime: s.regime, ex5: ex(5), ex20: ex(20), up20: c[i + 20] / c[i] - 1 });
    }
  }
  rows.sort((a, z) => a.date.localeCompare(z.date));
  const cut = rows.length ? rows[Math.floor(rows.length * 0.6)].date : null;
  const stat = (g, k, dir) => {
    const v = g.map(r => r[k]).filter(x => x != null); if (!v.length) return null;
    const hit = v.filter(x => (dir > 0 ? x > 0 : x < 0)).length / v.length * 100;
    const signed = v.map(x => x * dir * 100);
    const wins = signed.filter(x => x > 0), loss = signed.filter(x => x <= 0);
    const avgW = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0, avgL = loss.length ? -loss.reduce((s, x) => s + x, 0) / loss.length : 0;
    return { n: v.length, hit: +hit.toFixed(1), avg: +(signed.reduce((s, x) => s + x, 0) / v.length).toFixed(2), avgWin: +avgW.toFixed(2), avgLoss: +avgL.toFixed(2), payoff: avgL > 0 ? +(avgW / avgL).toFixed(2) : null };
  };
  const mk = subset => {
    const table = {};
    for (const [name, f] of BUCKETS) {
      const g = subset.filter(r => f(r.score)), dir = /偏多/.test(name) ? 1 : /偏空/.test(name) ? -1 : 1;
      const tr = g.filter(r => r.date < cut), te = g.filter(r => r.date >= cut);
      table[name] = { dir, share: subset.length ? +(g.length / subset.length * 100).toFixed(1) : 0 };
      for (const k of ['ex5', 'ex20', 'up20']) {
        const a = stat(tr, k, dir), z = stat(te, k, dir);
        table[name][k] = { train: a, test: z, high: !!(name !== '中性' && z && a && z.hit >= 65 && z.n >= 40 && a.hit >= 60) };
      }
    }
    return table;
  };
  const table = mk(rows), regimes = { bull: mk(rows.filter(r => r.regime === 'bull')), bear: mk(rows.filter(r => r.regime === 'bear')) };
  const regShare = { bull: +(rows.filter(r => r.regime === 'bull').length / Math.max(1, rows.length) * 100).toFixed(1) };
  return { cut, n: rows.length, from: rows[0]?.date || null, to: rows[rows.length - 1]?.date || null, table, regimes, regShare };
}

/**
 * 籌碼分數（台股，FinMind 法人買賣超）：五項固定條件，偏多＋1、偏空−1（−5 ～ +5）
 *   1. 外資連續買超 ≥ 3 日 ／ 連續賣超 ≥ 3 日
 *   2. 投信連續買超 ≥ 3 日 ／ 連續賣超 ≥ 3 日
 *   3. 外資與投信當日同步買超 ／ 同步賣超
 *   4. 投信近 5 日淨買超 ≥ 5 日成交量的 0.5% ／ 淨賣超 ≥ 0.5%
 *   5. 外資近 20 日累計買超 ／ 賣超
 * hist：[{date, foreign, trust}]（張），b.volume 為股數
 */
function chipScore(b, hist, tech) {
  const n = b.close.length, by = new Map(hist.map(h => [h.date, h]));
  const out = new Array(n).fill(null);
  let fS = 0, tS = 0; const F = [], Tq = [], V = [];
  for (let i = 0; i < n; i++) {
    const h = by.get(b.dates[i]);
    if (!h) { F.push(null); Tq.push(null); V.push(b.volume?.[i] || 0); continue; }
    fS = h.foreign > 0 ? Math.max(1, fS + 1) : h.foreign < 0 ? Math.min(-1, fS - 1) : 0;
    tS = h.trust > 0 ? Math.max(1, tS + 1) : h.trust < 0 ? Math.min(-1, tS - 1) : 0;
    F.push(h.foreign); Tq.push(h.trust); V.push(b.volume?.[i] || 0);
    const okN = F.slice(-20).filter(x => x != null).length;
    if (okN < 15) continue;
    const t5 = Tq.slice(-5).reduce((s2, x) => s2 + (x || 0), 0) * 1000, v5 = V.slice(-5).reduce((s2, x) => s2 + x, 0);
    const f20 = F.slice(-20).reduce((s2, x) => s2 + (x || 0), 0);
    const items = [
      ['外資連續', fS >= 3 ? 1 : fS <= -3 ? -1 : 0, fS > 0 ? `外資連買 ${fS} 日` : fS < 0 ? `外資連賣 ${-fS} 日` : '外資無連續'],
      ['投信連續', tS >= 3 ? 1 : tS <= -3 ? -1 : 0, tS > 0 ? `投信連買 ${tS} 日` : tS < 0 ? `投信連賣 ${-tS} 日` : '投信無連續'],
      ['外資投信同步', h.foreign > 0 && h.trust > 0 ? 1 : h.foreign < 0 && h.trust < 0 ? -1 : 0, h.foreign > 0 && h.trust > 0 ? '今日同步買超' : h.foreign < 0 && h.trust < 0 ? '今日同步賣超' : '方向不一致'],
      ['投信 5 日', v5 > 0 && t5 / v5 >= 0.005 ? 1 : v5 > 0 && t5 / v5 <= -0.005 ? -1 : 0, v5 > 0 ? `投信 5 日淨${t5 >= 0 ? '買' : '賣'} ${(Math.abs(t5) / v5 * 100).toFixed(2)}% 成交量` : '無成交量'],
      ['外資 20 日', f20 > 0 ? 1 : -1, `外資 20 日累計${f20 >= 0 ? '買' : '賣'} ${Math.round(Math.abs(f20)).toLocaleString()} 張`],
    ];
    out[i] = { date: b.dates[i], score: items.reduce((s2, x) => s2 + x[1], 0), items, regime: tech?.scores?.[i]?.regime ?? null };
  }
  return { scores: out, bc: tech.bc };
}
/** 技術＋籌碼同步：技術信心 ≥ +3 且籌碼 ≥ +2 → +5；技術 ≤ −3 且籌碼 ≤ −2 → −5；其他 0 */
function comboScore(tech, chip) {
  return { bc: tech.bc, scores: tech.scores.map((t, i) => { const c = chip.scores[i]; if (!t || !c) return null; const v = t.score >= 3 && c.score >= 2 ? 5 : t.score <= -3 && c.score <= -2 ? -5 : 0; return { date: t.date, score: v, regime: t.regime, items: [] }; }) };
}

module.exports = { score, chipScore, comboScore, evaluate, bucketOf, BUCKETS };
