'use strict';
/**
 * 調整建議 → 你確認 → 才套用到網站訊號
 *
 *   1. 每週回測校正後，若「校正帳」參數和網站目前用的不一樣，就產生一則建議（附回測、實盤、影響範圍）
 *   2. 推播／信件通知；網站「待確認」頁顯示完整資訊，按「同意／拒絕／稍後」
 *   3. 你的選擇跟著個人資料加密同步到私密 Gist（approvals）；下一次更新讀到「同意」才套用
 *   4. 拒絕的同一組參數 30 天內不再提；隨時可以「恢復網站預設」
 */
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const DEF = { buyTh: 63, sellTh: 37, stopK: 2 };
const same = (a, b) => a && b && a.buyTh === b.buyTh && a.sellTh === b.sellTh && a.stopK === b.stopK;
const pid = (m, p) => `${m}-b${p.buyTh}-s${p.sellTh}-k${p.stopK}`;
const MK = { tw: '台股', us: '美股' };

/** 網站目前用的參數（沒核准過＝預設） */
const current = (sp, m) => ({ ...DEF, ...(sp?.[m] || {}) });

/** 依參數重算訊號（買進門檻保留 VIX 調整的差額） */
function applySignal(sig, sp, m, price, atr) {
  const p = sp?.[m]; if (!p) return sig;
  const vixAdj = (sig.buyThreshold ?? 63) - 63, bt = p.buyTh + vixAdj;
  const s = sig.score >= bt ? 'BUY' : sig.score <= p.sellTh ? 'SELL' : 'HOLD';
  return { ...sig, sig: s, buyThreshold: bt, sellThreshold: p.sellTh, stopK: p.stopK, custom: true, ...(atr ? { stopCalc: price - p.stopK * atr } : {}) };
}

/** 讀到你的選擇就套用；回傳這次有沒有變更 */
function applyApprovals(st, approvals, log = () => {}) {
  st.site = st.site || {}; st.list = st.list || []; st.applied = st.applied || {};
  let changed = false;
  for (const [id, a] of Object.entries(approvals || {}).sort((x, y) => String(x[1].at).localeCompare(String(y[1].at)))) {
    if (st.applied[id] === a.at) continue;
    st.applied[id] = a.at;
    if (id.startsWith('revert-')) {
      const m = id.split('-')[1];
      if (m === 'w') { if (st.site.mlW != null) { st.list.push({ id, m: 'all', type: 'revert', status: 'approved', at: a.at, from: { mlW: st.site.mlW } }); delete st.site.mlW; delete st.site.mlWSince; changed = true; } continue; }
      if (st.site[m]) { st.list.push({ id, m, type: 'revert', status: 'approved', at: a.at, from: st.site[m] }); delete st.site[m]; changed = true; log('恢復網站預設', m); }
      continue;
    }
    const p = st.list.find(x => x.id === id && x.status === 'pending'); if (!p) continue;
    if (a.choice === 'approve' && p.type === 'weights') { st.site.mlW = p.to.mlW; st.site.mlWSince = a.at; p.status = 'approved'; changed = true; log('已核准權重', id); }
    else if (a.choice === 'approve') { st.site[p.m] = { ...p.to, since: a.at, from: id }; p.status = 'approved'; changed = true; log('已核准', id); }
    else if (a.choice === 'reject') { p.status = 'rejected'; changed = true; }
    p.decidedAt = a.at;
  }
  return changed;
}

/** 校正後檢查要不要產生建議 */
function propose(st, m, { tune, paper, items, now = new Date().toISOString() }) {
  st.site = st.site || {}; st.list = st.list || [];
  const cand = tune?.params, cur = current(st.site, m);
  const pend = st.list.filter(x => x.m === m && x.status === 'pending' && x.type !== 'weights');
  if (!cand || same(cand, cur)) { for (const x of pend) { x.status = 'superseded'; x.decidedAt = now; } return null; }
  const id = pid(m, cand);
  const rej = st.list.find(x => x.id === id && x.status === 'rejected' && Date.now() - Date.parse(x.decidedAt || x.at) < 30 * 86400000);
  if (rej) return null;
  for (const x of pend) if (x.id !== id) { x.status = 'superseded'; x.decidedAt = now; }
  // 影響範圍：如果今天就套用，哪些訊號會變
  const changes = [];
  let buyNow = 0, buyNew = 0;
  for (const it of Object.values(items).filter(i => i.market === m && i.signal)) {
    const g = it.signal, adj = (g.buyThreshold ?? 63) - (cur.buyTh ?? 63);
    const s1 = g.score >= cand.buyTh + adj ? 'BUY' : g.score <= cand.sellTh ? 'SELL' : 'HOLD';
    if (g.sig === 'BUY') buyNow++; if (s1 === 'BUY') buyNew++;
    if (s1 !== g.sig) changes.push({ k: it.key, name: it.name, from: g.sig, to: s1, score: g.score });
  }
  const B = paper?.base, T = paper?.tuned, n = T?.closed || 0;
  const strength = n >= 30 ? '強' : n >= 10 ? '中' : '弱';
  const bt = tune.best?.test, ct = tune.current?.test;
  const liveBetter = B && T && T.closed >= 10 && (T.exAvg ?? -99) > (B.exAvg ?? -99) && T.total > B.total;
  const btBetter = bt?.n && ct?.n && (bt.exAvg ?? -99) > (ct.exAvg ?? -99);
  const rec = liveBetter && btBetter ? 'approve' : btBetter ? 'wait' : 'reject';
  const reasons = [];
  if (btBetter) reasons.push(`回測驗證期平均超額 ${bt.exAvg}% 優於目前的 ${ct.exAvg}%`); else reasons.push('回測驗證期沒有明顯優於目前參數');
  if (T && B) reasons.push(T.closed >= 10 ? `實盤校正帳 ${T.closed} 筆，${liveBetter ? '績效與贏大盤比例都優於原始帳' : '還沒有贏過原始帳'}` : `實盤校正帳只有 ${T.closed} 筆平倉，證據還不夠`);
  if (bt?.n && ct?.n) reasons.push(`交易次數 ${ct.n} → ${bt.n} 筆、平均持有 ${ct.days} → ${bt.days} 天`);
  const p = {
    id, m, at: pend.find(x => x.id === id)?.at || now, updated: now, status: 'pending', type: 'thresholds',
    title: `${MK[m]}訊號門檻調整`, from: cur, to: { buyTh: cand.buyTh, sellTh: cand.sellTh, stopK: cand.stopK },
    rec, strength, reasons,
    backtest: { period: tune.period, stocks: tune.stocks, current: tune.current, candidate: tune.best },
    live: B && T ? { since: paper.since, base: pick(B), tuned: pick(T) } : null,
    accuracy: paper?.accuracy || null,
    impact: { buyNow, buyNew, changes: changes.slice(0, 20) },
  };
  st.list = st.list.filter(x => !(x.id === id && x.status === 'pending'));
  st.list.push(p);
  if (st.list.length > 100) st.list.splice(0, st.list.length - 100);
  return p;
}
const pick = b => ({ total: r2(b.total, 0), closed: b.closed, win: b.win, beat: b.beat, exAvg: b.exAvg, open: b.open?.length || 0 });

/** 技術 vs 模型：命中率差距夠大時，建議調整模型權重（同樣要你確認） */
function proposeWeights(st, skill, now = new Date().toISOString()) {
  st.site = st.site || {}; st.list = st.list || [];
  const cur = st.site.mlW ?? 0.5, to = skill?.suggest;
  const pend = st.list.filter(x => x.type === 'weights' && x.status === 'pending');
  if (to == null || Math.abs(to - cur) < 0.05) { for (const x of pend) { x.status = 'superseded'; x.decidedAt = now; } return null; }
  const id = `w-${to}`;
  if (st.list.find(x => x.id === id && x.status === 'rejected' && Date.now() - Date.parse(x.decidedAt || x.at) < 30 * 86400000)) return null;
  for (const x of pend) if (x.id !== id) { x.status = 'superseded'; x.decidedAt = now; }
  const better = (skill.ml.rate ?? 0) > (skill.ta.rate ?? 0) ? '模型' : '技術面';
  const p = { id, type: 'weights', m: 'all', at: pend.find(x => x.id === id)?.at || now, updated: now, status: 'pending', title: '綜合分數的模型權重調整',
    from: { mlW: cur }, to: { mlW: to }, rec: Math.min(skill.ta.n, skill.ml.n) >= 150 ? 'approve' : 'wait', strength: Math.min(skill.ta.n, skill.ml.n) >= 150 ? '強' : Math.min(skill.ta.n, skill.ml.n) >= 80 ? '中' : '弱',
    reasons: [`近期方向命中率：技術面 ${skill.ta.rate}%（${skill.ta.n} 次）、模型 ${skill.ml.rate}%（${skill.ml.n} 次）`, `${better}比較準，建議模型權重 ${Math.round(cur * 100)}% → ${Math.round(to * 100)}%（技術面 ${Math.round((1 - to) * 100)}%）`, '只計算分數明顯偏多或偏空（離 50 分 10 分以上）、5 日後漲跌超過 0.5% 的紀錄'],
    skill };
  st.list = st.list.filter(x => !(x.id === id && x.status === 'pending')); st.list.push(p);
  return p;
}
/** 給網站：待確認＋最近的紀錄＋目前參數 */
function view(st) {
  const L = st.list || [];
  return { site: st.site || {}, defaults: DEF, pending: L.filter(x => x.status === 'pending'), recent: L.filter(x => x.status !== 'pending').slice(-8).reverse() };
}

module.exports = { applySignal, applyApprovals, propose, proposeWeights, view, current, DEF };
