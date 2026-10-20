'use strict';
/**
 * modules/outcomes.js — 預測結果回填（依日 K 定位「第 N 個交易日收盤」）
 *
 * 舊做法的問題：
 *   - 到期時抓「當下即時價」當結果（盤中價、或已是下一天的價格）
 *   - 把「自然日數」當「K 棒根數」往回數，週末/假日後會取到訊號之前的價格
 *   - 15 日預測在 UTC 換日當下回填，取到的是前一交易日收盤
 *
 * 新做法：
 *   1. 依標的所屬市場換算訊號的「當地交易日」：開盤前發出的訊號算前一交易日
 *   2. 在日 K 中找到該交易日的位置 i0（最後一根 date ≤ 訊號日）
 *   3. 第 N 個交易日的收盤 = bars[i0 + N]，且那根 K 必須已收完（日期早於今天，或今天已收盤）
 */

const MARKETS = {
  us:     { tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
  tw:     { tz: 'Asia/Taipei',      open: 9 * 60,      close: 13 * 60 + 30 },
  crypto: { tz: 'UTC',              open: 0,           close: 24 * 60 },
};

function marketOf(sym) {
  const s = String(sym || '').toUpperCase();
  if (/^TW_/.test(s) || /^\d{4,6}[A-Z]?(\.TWO?)?$/.test(s)) return 'tw';
  if (/USDT$/.test(s) || /^[A-Z]{2,6}-USD$/.test(s)) return 'crypto';
  return 'us';
}

/** 某時刻在該市場的當地日期 YYYY-MM-DD 與分鐘數 */
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (+p.hour) * 60 + (+p.minute) };
}

/**
 * 找出訊號基準 K 棒的索引 i0。
 * @param {string[]} dates  日 K 日期（舊→新，YYYY-MM-DD）
 */
function baseIndex(dates, sym, timestamp) {
  const m = MARKETS[marketOf(sym)];
  const { date, minutes } = localParts(new Date(timestamp).getTime(), m.tz);
  const beforeOpen = minutes < m.open;
  // 開盤前：價格其實是前一交易日收盤 → 基準為「早於當天」的最後一根
  let i0 = -1;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (beforeOpen ? d < date : d <= date) i0 = i; else break;
  }
  return i0;
}

/** 這根日 K 是否已收完 */
function isBarComplete(sym, barDate, nowMs = Date.now()) {
  const m = MARKETS[marketOf(sym)];
  const { date, minutes } = localParts(nowMs, m.tz);
  if (barDate < date) return true;
  return barDate === date && minutes >= m.close + 15;   // 收盤後 15 分鐘
}

/**
 * 訊號後第 n 個交易日的收盤。
 * @param {{dates:string[], closes:number[]}} bars
 * @returns {{date:string, close:number}|null}
 */
function closeAfter(bars, sym, timestamp, n) {
  if (!bars || !bars.dates || !bars.dates.length) return null;
  const i0 = baseIndex(bars.dates, sym, timestamp);
  if (i0 < 0) return null;                      // 日 K 沒涵蓋到訊號日
  const i = i0 + n;
  if (i >= bars.dates.length) return null;     // 還沒到期
  if (!isBarComplete(sym, bars.dates[i])) return null;
  return { date: bars.dates[i], close: bars.closes[i] };
}

/** 方向判定（對稱門檻，單位 %） */
function judgeSignal(signal, priceAt, priceThen, thr = 0.5) {
  if (!(priceAt > 0) || !(priceThen > 0)) return null;
  const chg = (priceThen - priceAt) / priceAt * 100;
  const s = String(signal).toUpperCase();
  if (s === 'BUY' || s === 'UP')    return chg >= thr ? 'correct' : chg <= -thr ? 'wrong' : 'neutral';
  if (s === 'SELL' || s === 'DOWN') return chg <= -thr ? 'correct' : chg >= thr ? 'wrong' : 'neutral';
  if (s === 'FLAT')                 return Math.abs(chg) < thr ? 'correct' : 'wrong';
  return 'neutral';
}

function direction(priceAt, priceThen, thr) {
  if (!(priceAt > 0) || !(priceThen > 0)) return null;
  const chg = (priceThen - priceAt) / priceAt * 100;
  return chg >= thr ? 'up' : chg <= -thr ? 'down' : 'flat';
}

module.exports = { MARKETS, marketOf, localParts, baseIndex, isBarComplete, closeAfter, judgeSignal, direction };
