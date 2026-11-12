'use strict';
/**
 * 準確度與資料品質
 *   aiRecord／aiEvaluate ── AI 評論的多空傾向，5 個交易日後用加權、標普對答案（雲端 AI、電腦 AI 分開算）
 *   componentSkill     ── 技術分數與模型分數各自的方向命中率 → 建議的模型權重（要你確認才會套用）
 *   dataCheck          ── 每個數字的資料日期是否一致、是否過舊（避免拿不同時間點的數字互相比較）
 */
const r2 = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

// ── AI 評論傾向 ────────────────────────────────────────────
const BULL = /反彈|轉強|回升|偏多|看多|樂觀|買進|加碼|上攻|突破|走強|利多|築底|止跌/g;
const BEAR = /下跌|重挫|轉弱|偏空|看空|悲觀|賣出|減碼|降低持股|提高現金|風險升高|賣壓|跌破|利空|恐慌|修正|回檔/g;
function stanceOf(text) {
  const t = String(text || ''); const b = (t.match(BULL) || []).length, s = (t.match(BEAR) || []).length;
  return b - s >= 2 ? '偏多' : s - b >= 2 ? '偏空' : b > s ? '偏多' : s > b ? '偏空' : '中性';
}
function aiRecord(log, { day, src, tw, us, twii, gspc }) {
  if (!day || log.some(x => x.d === day && x.src === src)) return;
  log.push({ d: day, src, tw, us, twii, gspc });
  while (log.length > 1500) log.shift();
}
function aiEvaluate(log, barsOf) {
  const score = (st, b, d0, p0) => {
    if (!b || !st || !p0) return null; const i = b.dates.findIndex(x => x > d0); if (i < 0 || i + 4 >= b.close.length) return null;
    const ret = (b.close[i + 4] / p0 - 1) * 100;
    return { ret, hit: st === '偏多' ? ret > 0 : st === '偏空' ? ret < 0 : Math.abs(ret) < 1 };
  };
  const out = {};
  for (const src of ['cloud', 'pc']) {
    const rows = log.filter(x => x.src === src).map(x => ({ ...x, rt: score(x.tw, barsOf('^TWII'), x.d, x.twii), ru: score(x.us, barsOf('^GSPC'), x.d, x.gspc) }));
    const done = rows.filter(r => r.rt || r.ru);
    const hit = f => { const a = done.map(f).filter(Boolean); return a.length ? { n: a.length, rate: r2(a.filter(x => x.hit).length / a.length * 100, 0) } : null; };
    out[src] = { n: rows.length, tw: hit(r => r.rt), us: hit(r => r.ru),
      dist: ['偏多', '偏空', '中性'].map(s => [s, rows.filter(r => r.tw === s).length]),
      recent: rows.slice(-6).reverse().map(r => ({ d: r.d, tw: r.tw, us: r.us, twRet: r2(r.rt?.ret), twHit: r.rt?.hit ?? null, usRet: r2(r.ru?.ret), usHit: r.ru?.hit ?? null })) };
  }
  return out;
}

// ── 技術 vs 模型 的命中率 → 建議權重 ───────────────────────────
function componentSkill(preds, barsOf) {
  const acc = { ta: [], ml: [] };
  for (const p of preds) {
    if (p.ta == null && p.mls == null) continue;
    const b = barsOf(p.key); if (!b) continue;
    const i = b.dates.indexOf(p.date); if (i < 0 || i + 5 >= b.close.length) continue;
    const ret = (b.close[i + 5] / b.close[i] - 1) * 100; if (Math.abs(ret) < 0.5) continue;
    for (const [k, v] of [['ta', p.ta], ['ml', p.mls]]) if (v != null && Math.abs(v - 50) >= 10) acc[k].push(v > 50 ? ret > 0 : ret < 0);
  }
  const rate = a => (a.length ? a.filter(Boolean).length / a.length : null);
  const hT = rate(acc.ta), hM = rate(acc.ml), nT = acc.ta.length, nM = acc.ml.length;
  let w = 0.5;
  if (hT != null && hM != null && nT >= 40 && nM >= 40) {
    const raw = 0.5 + (hM - hT) * 2;   // 命中率差 10 個百分點 → 權重差 0.2
    const shrink = Math.min(nT, nM) / (Math.min(nT, nM) + 150);
    w = Math.round(Math.min(0.7, Math.max(0.3, 0.5 + (raw - 0.5) * shrink)) * 20) / 20;   // 0.05 為一級
  }
  return { ta: { n: nT, rate: hT == null ? null : r2(hT * 100, 0) }, ml: { n: nM, rate: hM == null ? null : r2(hM * 100, 0) }, suggest: w };
}

// ── 資料日期檢查 ──────────────────────────────────────────
function tradingDaysBetween(a, b) {   // a、b：YYYY-MM-DD，算 a 之後到 b（含）有幾個平日
  let n = 0, t = Date.parse(a + 'T00:00:00Z'); const e = Date.parse(b + 'T00:00:00Z');
  while ((t += 86400000) <= e) { const w = new Date(t).getUTCDay(); if (w > 0 && w < 6) n++; }
  return n;
}
const norm = d => (d ? String(d).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3').slice(0, 10) : null);
function dataCheck(snap) {
  const twD = norm(snap.indices?.['^TWII']?.marketDate), usD = norm(snap.indices?.['^GSPC']?.marketDate);
  const rows = [];
  const add = (label, date, ref, maxLag, note) => { const d = norm(date); if (!d || !ref) return; const lag = d >= ref ? 0 : tradingDaysBetween(d, ref); rows.push({ label, date: d, ref, lag, ok: lag <= maxLag, note }); };
  for (const e of snap.env || []) {
    const us = ['spx', 'ndx', 'vix', 'curve', 'dxy'].includes(e.key);
    add(e.label, e.date, us ? usD : twD, e.key === 'curve' ? 2 : 1, us ? '對照美股收盤日' : '對照台股收盤日');
  }
  add('大盤籌碼（外資）', snap.chipMarket?.date, twD, 1, '對照台股收盤日');
  const chips = Object.values(snap.items || {}).filter(i => i.market === 'tw' && i.chip?.date).map(i => i.chip.date).sort();
  if (chips.length) add('個股籌碼', chips[0], twD, 2, '最舊的一檔');
  const tdcc = Object.values(snap.items || {}).map(i => i.tdcc?.[0]?.date).filter(Boolean).sort();
  if (tdcc.length) add('大戶持股（集保）', tdcc[tdcc.length - 1], twD, 7, '每週更新');
  if (snap.health?.us?.vixTerm?.date) add('VIX 期限結構', snap.health.us.vixTerm.date, usD, 1, '近月與三個月同一天');
  const bad = rows.filter(r => !r.ok);
  return { at: snap.generatedAt, twDate: twD, usDate: usD, rows, bad: bad.length, mismatch: twD && usD && Math.abs(Date.parse(twD) - Date.parse(usD)) > 5 * 86400000 };
}

module.exports = { stanceOf, aiRecord, aiEvaluate, componentSkill, dataCheck };
