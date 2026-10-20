'use strict';
/**
 * modules/yahooChart.js — 解析 Yahoo v8 chart 回應（1h K）
 *
 * - 逐根對齊 OHLCV：close 為 null 的整根丟棄（不可各欄位各自 filter，會錯位）
 * - 前一交易日收盤：依交易所當地日期分組，取最新交易日之前那天最後一根收盤。
 *   range=7d 時 meta.chartPreviousClose 是「整段區間開始前」的收盤（約 5 個交易日前），不能當昨收。
 */
function parseChart(result) {
  const meta  = result?.meta || {};
  const quote = result?.indicators?.quote?.[0];
  const ts    = result?.timestamp || [];
  const bars  = [];
  if (quote) {
    for (let i = 0; i < ts.length; i++) {
      const c = quote.close?.[i];
      if (c == null || !(c > 0)) continue;
      const h = quote.high?.[i], l = quote.low?.[i], o = quote.open?.[i], v = quote.volume?.[i];
      bars.push({ t: ts[i], c, h: h > 0 ? h : c, l: l > 0 ? l : c, o: o > 0 ? o : c, v: v ?? 0 });
    }
  }
  const gmtoff = meta.gmtoffset ?? 0;
  const dayOf = t => new Date((t + gmtoff) * 1000).toISOString().slice(0, 10);
  let prevClose = 0, todayOpen = null, todayHigh = null, todayLow = null, todayVol = 0;
  if (bars.length) {
    const lastDay   = dayOf(bars[bars.length - 1].t);
    const todayBars = bars.filter(b => dayOf(b.t) === lastDay);
    const before    = bars.filter(b => dayOf(b.t) < lastDay);
    if (before.length) prevClose = before[before.length - 1].c;
    todayOpen = todayBars[0]?.o ?? null;
    todayHigh = Math.max(...todayBars.map(b => b.h));
    todayLow  = Math.min(...todayBars.map(b => b.l));
    todayVol  = todayBars.reduce((a, b) => a + (b.v || 0), 0);
  }
  if (!prevClose) prevClose = meta.previousClose ?? 0;   // range=1d 才有，保底
  return { bars, prevClose, todayOpen, todayHigh, todayLow, todayVol };
}

module.exports = { parseChart };
