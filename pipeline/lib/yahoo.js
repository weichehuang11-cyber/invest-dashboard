'use strict';
/**
 * Yahoo 財經日 K（v8 chart，interval=1d）。一次呼叫同時拿到：
 *   - 日 K（舊→新，含今天盤中這根）
 *   - 現價與「相對前一交易日收盤」的漲跌
 * 前一交易日收盤 = 交易所當地日期早於最新交易日的最後一根日 K 收盤
 * （不可用 chartPreviousClose：那是整段區間開始前的收盤）。
 */
const { get } = require('./http');

function yahooSymbol(key) {
  const k = String(key).toUpperCase();
  if (/^TW_/.test(k)) return k.slice(3) + '.TW';
  if (/^\d{4,6}[A-Z]?$/.test(k)) return k + '.TW';
  return k;
}

function parseDaily(json) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const meta = r.meta || {};
  const q = r.indicators?.quote?.[0] || {};
  const gmt = meta.gmtoffset ?? 0;
  const ts = r.timestamp || [];
  const byDate = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null || !(c > 0)) continue;
    const d = new Date((ts[i] + gmt) * 1000).toISOString().slice(0, 10);
    byDate.set(d, {                       // 同一天重複時以後面那筆為準
      date: d, open: q.open?.[i] > 0 ? q.open[i] : c, high: q.high?.[i] > 0 ? q.high[i] : c,
      low: q.low?.[i] > 0 ? q.low[i] : c, close: c, volume: q.volume?.[i] ?? 0,
    });
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return null;
  const price = meta.regularMarketPrice ?? rows[rows.length - 1].close;
  const mktDate = meta.regularMarketTime ? new Date((meta.regularMarketTime + gmt) * 1000).toISOString().slice(0, 10) : rows[rows.length - 1].date;
  // 盤中最新那根的收盤 = 現價
  if (rows[rows.length - 1].date === mktDate) rows[rows.length - 1].close = price;
  const prior = rows.filter(x => x.date < mktDate);
  const prevClose = prior.length ? prior[prior.length - 1].close : null;
  return {
    symbol: meta.symbol, currency: meta.currency || null, exchange: meta.exchangeName || null,
    name: meta.shortName || meta.longName || null,
    price, prevClose, change: prevClose ? price - prevClose : null,
    changePct: prevClose ? (price / prevClose - 1) * 100 : null,
    marketDate: mktDate, marketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
    marketState: meta.marketState || null,
    high52: meta.fiftyTwoWeekHigh ?? null, low52: meta.fiftyTwoWeekLow ?? null,
    bars: {
      dates: rows.map(x => x.date), open: rows.map(x => x.open), high: rows.map(x => x.high),
      low: rows.map(x => x.low), close: rows.map(x => x.close), volume: rows.map(x => x.volume),
    },
  };
}

/** 台股自動試 .TW（上市）→ .TWO（上櫃） */
async function daily(key, range = '2y') {
  const sym = yahooSymbol(key);
  const tries = sym.endsWith('.TW') ? [sym, sym.replace(/\.TW$/, '.TWO')] : [sym];
  for (const s of tries) {
    try {
      const j = await get(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=${range}&includePrePost=false`);
      const d = parseDaily(j);
      if (d && d.bars.close.length) return { ...d, yahoo: s };
    } catch (_) { /* 換下一個寫法 */ }
  }
  return null;
}

module.exports = { daily, parseDaily, yahooSymbol };
