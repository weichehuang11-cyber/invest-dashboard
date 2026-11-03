'use strict';
/**
 * 產業分類：config/industries.json 的每一檔抓日 K，算出
 *   個股：今日、5／20／60 日報酬、是否站上 20／60 日線、距 52 週高點、近 60 日收盤
 *   產業：等權平均的今日漲跌、5／20／60 日報酬（與大盤比較）、上漲／下跌家數、站上 20 日線比例、近 60 日等權指數
 * 收盤後完整更新才重抓該市場（台股、美股分開），其他時候沿用上一次的結果
 */
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const avg = a => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const ret = (c, n) => (c.length > n && c[c.length - 1 - n] > 0 ? (c[c.length - 1] / c[c.length - 1 - n] - 1) * 100 : null);
const sma = (c, n) => (c.length >= n ? c.slice(-n).reduce((s, x) => s + x, 0) / n : null);

function stockStats(d) {
  const c = d.bars.close, n = c.length, last = c[n - 1];
  const m20 = sma(c, 20), m60 = sma(c, 60), hi = Math.max(...c.slice(-252));
  return {
    n: d.name || null, c: r2(last, 2), p: r2(d.changePct, 2), date: d.marketDate,
    r5: r2(ret(c, 5)), r20: r2(ret(c, 20)), r60: r2(ret(c, 60)),
    a20: m20 ? last > m20 : null, a60: m60 ? last > m60 : null, hi: r2((last / hi - 1) * 100, 1),
    dates: d.bars.dates.slice(-60), ser: c.slice(-60).map(v => r2(v, 2)),
  };
}

/** 等權指數：每天每檔對前一天的報酬取平均，連乘（起點 100） */
function groupIndex(members, dates) {
  const out = [100];
  for (let i = 1; i < dates.length; i++) {
    const rs = [];
    for (const s of members) {
      const a = s.dates.indexOf(dates[i - 1]), b = s.dates.indexOf(dates[i]);
      if (a >= 0 && b >= 0 && s.ser[a] > 0) rs.push(s.ser[b] / s.ser[a] - 1);
    }
    out.push(r2(out[i - 1] * (1 + (avg(rs) ?? 0)), 2));
  }
  return out;
}

function groupStats(keys, stocks, bench) {
  const S = keys.map(k => stocks[k]).filter(Boolean);
  if (!S.length) return null;
  const dates = bench?.dates?.slice(-60) || S[0].dates;
  const ser = groupIndex(S, dates);
  const rel = (x, b) => (x != null && b != null ? r2(x - b) : null);
  const r5 = r2(avg(S.map(s => s.r5))), r20 = r2(avg(S.map(s => s.r20))), r60 = r2(avg(S.map(s => s.r60)));
  return {
    n: S.length, chg: r2(avg(S.map(s => s.p))), up: S.filter(s => s.p > 0).length, down: S.filter(s => s.p < 0).length,
    r5, r20, r60, rs5: rel(r5, bench?.r5), rs20: rel(r20, bench?.r20), rs60: rel(r60, bench?.r60),
    above20: r2(S.filter(s => s.a20).length / S.length * 100, 0),
    best: [...S].sort((a, b) => (b.p ?? -99) - (a.p ?? -99))[0]?.n || null,
    dates, ser,
  };
}

/**
 * @param defs     config/industries.json
 * @param prev     上一次的結果（state/industries.json）
 * @param refresh  { tw: bool, us: bool }  哪個市場要重抓
 * @param getDaily async key → Yahoo.daily 結果（含 bars、changePct、name）
 * @param benchOf  m → 大盤 daily
 * @param names    key → 中文名稱（觀察清單、全市場清單）
 */
async function compute({ defs, prev, refresh, getDaily, benchOf, names = {}, log = () => {} }) {
  const stocks = { ...(prev?.stocks || {}) }, bench = { ...(prev?.bench || {}) };
  for (const m of ['tw', 'us']) {
    const need = refresh[m] || !(prev?.bench?.[m]);
    if (!need) continue;
    const keys = [...new Set(defs.groups.filter(g => g.m === m).flatMap(g => g.subs.flatMap(s => s.keys)))];
    let ok = 0;
    for (const k of keys) {
      try { const d = await getDaily(k); if (d?.bars?.close?.length > 25) { stocks[k] = { ...stockStats(d), n: names[k] || d.name || k, m }; ok++; } } catch (_) { /* 沿用上一次 */ }
    }
    const b = benchOf(m);
    if (b?.bars?.close?.length) { const c = b.bars.close; bench[m] = { name: m === 'tw' ? '加權指數' : '標普 500', r5: r2(ret(c, 5)), r20: r2(ret(c, 20)), r60: r2(ret(c, 60)), p: r2(b.changePct), dates: b.bars.dates.slice(-60), ser: c.slice(-60).map(v => r2(v, 2)) }; }
    log(`產業分類 ${m}：${ok}/${keys.length} 檔`);
  }
  const groups = defs.groups.map(g => {
    const all = [...new Set(g.subs.flatMap(s => s.keys))];
    return { id: g.id, name: g.name, m: g.m, desc: g.desc || '', stats: groupStats(all, stocks, bench[g.m]),
      subs: g.subs.map(s => ({ name: s.name, keys: s.keys, stats: groupStats(s.keys, stocks, bench[g.m]) })) };
  });
  // 只保留還在分類裡的股票
  const used = new Set(defs.groups.flatMap(g => g.subs.flatMap(s => s.keys)));
  for (const k of Object.keys(stocks)) if (!used.has(k)) delete stocks[k];
  return { at: new Date().toISOString(), bench, groups, stocks };
}

/** 給推播／週報：追蹤中的產業一行摘要 */
function line(g, bench) {
  const s = g.stats; if (!s) return null;
  const sg = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  return `${g.name}：今日 ${sg(s.chg)}（漲 ${s.up}／跌 ${s.down}）、5 日 ${sg(s.r5)}、20 日 ${sg(s.r20)}（${s.rs20 != null ? (s.rs20 >= 0 ? `強於${bench?.name || '大盤'} ${s.rs20.toFixed(1)}` : `弱於${bench?.name || '大盤'} ${Math.abs(s.rs20).toFixed(1)}`) + ' 個百分點' : ''}）、站上月線 ${s.above20}%`;
}

module.exports = { compute, line, groupStats };
