'use strict';
/** 今日判斷：把市場環境濃縮成一句話（規則式，理由全部列出） */

const LEVELS = [
  { min: 3, level: 2, label: '偏多', action: '可正常佈局' },
  { min: 1, level: 1, label: '中性偏多', action: '維持持股，可逢回加碼' },
  { min: -1, level: 0, label: '中性', action: '維持持股' },
  { min: -3, level: -1, label: '中性偏弱', action: '維持持股，暫緩加碼' },
  { min: -Infinity, level: -2, label: '偏空', action: '降低持股、提高現金' },
];

function build({ vix, spx, twii, foreign, curve, health }, prev) {
  const reasons = [];
  const add = (pts, text) => reasons.push({ pts, text });
  if (vix?.price != null) {
    if (vix.price > 25) add(-2, `VIX 恐慌指數 ${vix.price.toFixed(1)}，高於 25`);
    else if (vix.price > 20) add(-1, `VIX 恐慌指數 ${vix.price.toFixed(1)}，高於 20`);
    else if (vix.price < 15) add(1, `VIX 恐慌指數 ${vix.price.toFixed(1)}，波動低`);
    if (vix.changePct > 10) add(-1, `VIX 單日上升 ${vix.changePct.toFixed(0)}%`);
  }
  const vsMa = (x, name) => {
    if (!x?.ta?.ma20) return;
    if (x.price > x.ta.ma20) add(1, `${name}守住 20 日線`); else add(-1, `${name}跌破 20 日線`);
    if (x.ta.ma60 && x.price < x.ta.ma60) add(-1, `${name}低於 60 日線`);
  };
  vsMa(spx, '標普 500 ');
  vsMa(twii, '加權指數');
  if (foreign?.valueEst != null) {
    const yi = foreign.valueEst / 1e8;
    const streak = foreign.streak || 1;
    if (yi < -30) add(streak >= 3 ? -2 : -1, `外資賣超約 ${Math.abs(yi).toFixed(0)} 億${streak >= 2 ? `（連 ${streak} 日）` : ''}`);
    else if (yi > 30) add(streak >= 3 ? 2 : 1, `外資買超約 ${yi.toFixed(0)} 億${streak >= 2 ? `（連 ${streak} 日）` : ''}`);
  }
  const b = health?.tw?.breadth;
  if (b?.above20 != null) { if (b.above20 < 25) add(-1, `台股僅 ${b.above20.toFixed(0)}% 個股站上 20 日線`); else if (b.above20 > 75) add(1, `台股 ${b.above20.toFixed(0)}% 個股站上 20 日線`); }
  if (health?.tw?.futures?.chg5 < -10000) add(-1, `外資台指期 5 日增加空單 ${Math.abs(health.tw.futures.chg5).toLocaleString()} 口`);
  if (health?.us?.vixTerm?.ratio > 1) add(-1, 'VIX 期限結構倒掛（急性恐慌）');
  if (health?.us?.hy?.chg > 0.5) add(-1, `高收益債利差擴大 ${health.us.hy.chg.toFixed(2)} 個百分點`);
  if (curve?.spread != null && curve.spread < 0) add(-1, `美債 10 年減 2 年利差 ${curve.spread.toFixed(2)}，曲線倒掛`);

  const total = reasons.reduce((s, r) => s + r.pts, 0);
  const L = LEVELS.find(x => total >= x.min);
  const sorted = reasons.slice().sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  const trend = prev?.level == null ? null : L.level > prev.level ? '較前次轉強' : L.level < prev.level ? '較前次轉弱' : '與前次相同';
  return {
    level: L.level, label: L.label, action: L.action, points: total,
    headline: `風險偏好${L.label}：${L.action}`,
    detail: sorted.slice(0, 4).map(r => r.text).join('；') + (sorted.length ? '。' : '資料不足，暫無判斷。'),
    reasons: sorted, trend,
  };
}

module.exports = { build, LEVELS };
