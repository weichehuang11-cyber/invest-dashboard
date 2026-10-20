'use strict';
/**
 * 訊號引擎（日線）：技術面分數 → 與模型機率融合 → 買進／賣出／觀望
 * 權重與門檻沿用原系統預設（settings.js）：RSI 0.25、MACD 8、布林 0.10、趨勢 ±4、
 * 買進 ≥63、賣出 ≤37，VIX 越高買進門檻越高；模型權重 0.5。
 */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function taScore(ta, chg) {
  let s = 50 + clamp(chg ?? 0, -10, 10) * 1;
  if (!ta) return s;
  if (ta.rsi != null) s += (50 - ta.rsi) * 0.25;
  if (ta.macdPct != null) s += ta.macdPct * 8;
  if (ta.bbPct != null) s += (50 - ta.bbPct) * 0.10;
  if (ta.trend === 'up') s += 4; else if (ta.trend === 'down') s -= 4;
  if (ta.cross === 'golden') s += 3; else if (ta.cross === 'death') s -= 3;
  if (ta.relVolume > 2) s += (chg > 0 ? 4 : chg < 0 ? -4 : 0);
  if (ta.rsi != null && ta.rsi < 30) s += 5;
  if (ta.rsi != null && ta.rsi > 70) s -= 5;
  return clamp(s, 5, 95);
}

function buyThreshold(vix) {
  if (vix == null) return 63;
  return 63 + (vix > 35 ? 15 : vix > 25 ? 8 : vix < 15 ? -3 : 0);
}

/** 證據燈號：'pos' 支持、'neg' 反對、'neu' 中性、null 無資料 */
function evidence({ ta, tScore, chip, fund, ml, market }) {
  const ev = { tech: null, chip: null, fund: null, model: null };
  if (ta) ev.tech = tScore >= 55 ? 'pos' : tScore <= 45 ? 'neg' : 'neu';
  if (market === 'tw' && chip) {
    const net = (chip.foreign5 ?? 0) + (chip.trust5 ?? 0);
    const base = chip.volume5 > 0 ? Math.abs(net) / chip.volume5 : 1;
    ev.chip = base < 0.005 ? 'neu' : net > 0 ? 'pos' : 'neg';
  }
  if (fund) {
    if (market === 'tw' && fund.revenueYoY != null) ev.fund = fund.revenueYoY >= 10 ? 'pos' : fund.revenueYoY < 0 ? 'neg' : 'neu';
    else if (market === 'us') {
      const rm = fund.recommendationMean, rg = fund.revenueGrowth;
      if (rm != null || rg != null) ev.fund = (rm != null && rm <= 2.2 && !(rg < 0)) ? 'pos' : ((rm != null && rm >= 3) || rg < 0) ? 'neg' : 'neu';
    }
  }
  if (ml && ml.buyProb != null) {
    ev.model = (ml.buyProb >= 0.45 && ml.buyProb > ml.sellProb) ? 'pos' : (ml.sellProb >= 0.45 && ml.sellProb > ml.buyProb) ? 'neg' : 'neu';
  }
  return ev;
}

function score({ ta, changePct, ml, chip, fund, market, vix }) {
  const tScore = taScore(ta, changePct);
  let s = tScore;
  // 模型是三分類（賣/觀望/買），單看買進機率會把分數往下拉（基準約 33%）。
  // 改用「買進機率 − 賣出機率」以 50 為中心換算：模型沒有偏向時不影響分數。
  if (ml && ml.buyProb != null && !ml.error) {
    const mlScore = clamp(50 + (ml.buyProb - (ml.sellProb ?? 0)) * 100, 5, 95);
    s = 0.5 * s + 0.5 * mlScore;
  }
  s = clamp(s, 5, 95);
  const bt = buyThreshold(vix);
  const sig = s >= bt ? 'BUY' : s <= 37 ? 'SELL' : 'HOLD';
  return { sig, score: Math.round(s), taScore: Math.round(tScore), buyThreshold: bt, evidence: evidence({ ta, tScore, chip, fund, ml, market }) };
}

module.exports = { score, taScore, buyThreshold, evidence };
