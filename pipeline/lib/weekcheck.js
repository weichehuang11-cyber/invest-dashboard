'use strict';
/**
 * 週報「下週方向」對答案
 *   每次收盤後完整更新，把四大指數當天的 5 日推論（上漲機率、八成區間、最近的支撐壓力）存下來；
 *   每週最後一個交易日的那筆＝週報用的預測，5 個交易日後用實際收盤、最高、最低對答案。
 */
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const NAME = { '^TWII': '加權指數', '^GSPC': '標普 500', '^IXIC': '那斯達克', '^SOX': '費城半導體' };
const monday = d => { const t = Date.parse(d + 'T00:00:00Z'), w = new Date(t).getUTCDay(); return new Date(t - ((w + 6) % 7) * 86400000).toISOString().slice(0, 10); };
const viewOf = up => (up >= 58 ? '偏多' : up <= 42 ? '偏空' : '盤整');

function record(log, indices, full) {
  for (const [k, it] of Object.entries(indices)) {
    const f = it.outlook?.forecast?.h5; if (!f || !it.marketDate) continue;
    if (full !== 'all' && (k === '^TWII' ? full !== 'tw' : full !== 'us')) continue;
    if (log.some(x => x.k === k && x.d === it.marketDate)) continue;
    const sr = it.outlook.sr || {};
    log.push({ k, d: it.marketDate, p: it.price, up: f.upProb, q: f.q, sup: sr.support?.[0]?.p ?? null, supL: sr.support?.[0]?.label ?? null, res: sr.resistance?.[0]?.p ?? null, resL: sr.resistance?.[0]?.label ?? null });
  }
  while (log.length > 3000) log.shift();
}

function evaluate(log, barsOf) {
  // 每個指數每週取最後一筆
  const last = {};
  for (const x of log) { const w = monday(x.d), id = x.k + '|' + w; if (!last[id] || last[id].d < x.d) last[id] = x; }
  const weeks = {};
  for (const x of Object.values(last)) {
    const b = barsOf(x.k), w = monday(x.d);
    const row = { k: x.k, name: NAME[x.k] || x.k, base: x.d, p: x.p, up: x.up, view: viewOf(x.up), lo: r2(x.q?.[0]), hi: r2(x.q?.[4]), sup: x.sup, supL: x.supL, res: x.res, resL: x.resL, bf: !!x.bf, done: false };
    const j = b ? b.dates.indexOf(x.d) : -1;
    if (j >= 0) {
      const n = Math.min(5, b.dates.length - 1 - j);
      if (n > 0) {
        const seg = { c: b.close.slice(j + 1, j + 1 + n), h: (b.high || b.close).slice(j + 1, j + 1 + n), l: (b.low || b.close).slice(j + 1, j + 1 + n) };
        const close = seg.c[seg.c.length - 1], ret = (close / x.p - 1) * 100;
        row.days = n; row.close = r2(close); row.ret = r2(ret);
        row.wkHi = r2(Math.max(...seg.h)); row.wkLo = r2(Math.min(...seg.l));
        row.brokeSup = x.sup != null ? row.wkLo < x.sup : null; row.brokeRes = x.res != null ? row.wkHi > x.res : null;
        if (n >= 5) {
          row.done = true;
          row.inRange = x.q ? close >= x.q[0] && close <= x.q[4] : null;
          row.dirHit = row.view === '偏多' ? ret > 0 : row.view === '偏空' ? ret < 0 : x.q ? close >= x.q[1] && close <= x.q[3] : Math.abs(ret) < 1;
        }
      }
    }
    (weeks[w] = weeks[w] || []).push(row);
  }
  const list = Object.entries(weeks).sort((a, b) => b[0].localeCompare(a[0])).map(([w, rows]) => ({ week: w, rows: rows.sort((a, b) => Object.keys(NAME).indexOf(a.k) - Object.keys(NAME).indexOf(b.k)) }));
  const done = list.flatMap(x => x.rows).filter(r => r.done);
  const pctOf = f => (done.length ? r2(done.filter(f).length / done.length * 100, 0) : null);
  return { weeks: list.slice(0, 10), summary: { n: done.length, weeks: new Set(done.map(r => monday(r.base))).size, dirHit: pctOf(r => r.dirHit), inRange: pctOf(r => r.inRange) } };
}

/** 週報用：上週預測對答案（條列） */
function lines(wc) {
  const w = (wc?.weeks || []).find(x => x.rows.some(r => r.done)); if (!w) return null;
  const sg = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  const fx = v => (v == null ? '—' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1));
  const L = [];
  for (const r of w.rows.filter(r => r.done)) {
    L.push(`• ${r.name}：預測${r.view}（上漲機率 ${r.up}%）→ 實際 ${sg(r.ret)}　${r.dirHit ? '✓ 方向對' : '✗ 方向錯'}・${r.inRange ? '在八成區間內' : '超出八成區間'}`);
    const ev = [r.brokeSup ? `跌破支撐 ${fx(r.sup)}` : r.sup != null ? `守住支撐 ${fx(r.sup)}` : null, r.brokeRes ? `突破壓力 ${fx(r.res)}` : r.res != null ? `未過壓力 ${fx(r.res)}` : null].filter(Boolean);
    L.push(`　區間 ${fx(r.lo)}～${fx(r.hi)}，實際 ${fx(r.close)}（週高 ${fx(r.wkHi)}／週低 ${fx(r.wkLo)}）${ev.length ? '；' + ev.join('、') : ''}`);
  }
  const s = wc.summary;
  if (s?.n) L.push(`• 累計 ${s.weeks} 週、${s.n} 筆：方向命中 ${s.dirHit}%、落在八成區間 ${s.inRange}%（區間設計上應約 80%）`);
  return { week: w.week, base: w.rows.find(r => r.done)?.base, bf: w.rows.some(r => r.bf), lines: L };
}

module.exports = { record, evaluate, lines, viewOf };
