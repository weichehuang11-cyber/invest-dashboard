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

/** 產業輪動：和 5 個交易日前比，相對大盤由弱轉強（或反過來）、站上月線比例急升急降、進入前三強 */
function rotation(hist, res, day) {
  if (!day) return [];
  for (const g of res.groups) { if (!g.stats) continue; const H = hist[g.id] = (hist[g.id] || []).filter(x => x.d !== day); H.push({ d: day, rs20: g.stats.rs20, above20: g.stats.above20, r20: g.stats.r20 }); if (H.length > 120) H.shift(); }
  const rank = m => res.groups.filter(g => g.m === m && g.stats?.r20 != null).sort((a, b) => b.stats.r20 - a.stats.r20).map(g => g.id);
  const out = [];
  for (const g of res.groups) {
    const H = hist[g.id] || [], now = H[H.length - 1], ago = H[H.length - 6]; if (!now || !ago) continue;
    const bn = res.bench?.[g.m]?.name || '大盤';
    if (ago.rs20 != null && now.rs20 != null && ago.rs20 < 0 && now.rs20 > 0) out.push({ id: g.id, name: g.name, m: g.m, type: 'up', text: `${g.name} 由弱轉強：20 日表現從弱於${bn} ${Math.abs(ago.rs20).toFixed(1)} 個百分點，翻成強於 ${now.rs20.toFixed(1)}` });
    if (ago.rs20 != null && now.rs20 != null && ago.rs20 > 0 && now.rs20 < 0) out.push({ id: g.id, name: g.name, m: g.m, type: 'down', text: `${g.name} 由強轉弱：20 日表現從強於${bn} ${ago.rs20.toFixed(1)} 個百分點，翻成弱於 ${Math.abs(now.rs20).toFixed(1)}` });
    if (ago.above20 != null && now.above20 != null && ago.above20 <= 30 && now.above20 >= 60) out.push({ id: g.id, name: g.name, m: g.m, type: 'thrust', text: `${g.name} 廣度急升：站上月線的比例 5 天內從 ${ago.above20}% 升到 ${now.above20}%（常見於族群起漲）` });
    if (ago.above20 != null && now.above20 != null && ago.above20 >= 70 && now.above20 <= 40) out.push({ id: g.id, name: g.name, m: g.m, type: 'break', text: `${g.name} 廣度轉弱：站上月線的比例 5 天內從 ${ago.above20}% 降到 ${now.above20}%` });
  }
  for (const m of ['tw', 'us']) {
    const now = rank(m).slice(0, 3), prev = (hist._rank?.[m] || []);
    for (const id of now) if (prev.length && !prev.includes(id)) { const g = res.groups.find(x => x.id === id); out.push({ id, name: g.name, m, type: 'top', text: `${g.name} 進入${m === 'tw' ? '台股' : '美股'} 20 日最強前三名（${g.stats.r20 > 0 ? '+' : ''}${g.stats.r20.toFixed(1)}%）` }); }
    hist._rank = { ...(hist._rank || {}), [m]: now };
  }
  return out.map(x => ({ ...x, d: day }));
}

module.exports = { compute, line, groupStats, rotation };
