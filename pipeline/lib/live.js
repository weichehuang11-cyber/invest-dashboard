'use strict';
/**
 * 盤前即時報價（送盤前資訊當下才抓，不用網站上幾小時前的快照）
 *   quotes()     ── Yahoo：股價期貨、日韓股、歐股、美債殖利率、個股盤前價
 *   taifexNight()── 期交所：台指期夜盤（台股開盤方向最直接的參考）
 * 任何一個來源失敗都回傳空值，不影響其他內容。
 */
const isNum = v => typeof v === 'number' && Number.isFinite(v);

let _yf = null;
function yf() {
  if (_yf) return _yf;
  const YF = require('yahoo-finance2').default;
  _yf = typeof YF === 'function' ? new YF({ suppressNotices: ['yahooSurvey', 'ripHistorical'] }) : YF;
  return _yf;
}

async function quotes(symbols) {
  const out = {}; if (!symbols.length) return out;
  try {
    const r = await yf().quote(symbols, { return: 'array' }, { validateResult: false });
    for (const q of [].concat(r || [])) {
      if (!q?.symbol) continue;
      out[q.symbol] = {
        name: q.shortName || q.longName || q.symbol, price: q.regularMarketPrice, chg: q.regularMarketChangePercent,
        pre: isNum(q.preMarketPrice) ? q.preMarketPrice : null, preChg: isNum(q.preMarketChangePercent) ? q.preMarketChangePercent : null,
        state: q.marketState || null, time: q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null,
      };
    }
  } catch (e) { console.log('即時報價失敗：', e.message); }
  return out;
}

// 期交所行情網的查詢介面：MarketType 1＝盤後（夜盤）
async function taifexNight() {
  try {
    const r = await fetch('https://mis.taifex.com.tw/futures/api/getQuoteList', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ MarketType: '1', SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), list = j?.RtData?.QuoteList || [];
    const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const f = list.find(x => /^TXF/.test(x.SymbolID || '') && !/-S$/.test(x.SymbolID || '') && num(x.CLastPrice));
    if (!f) throw new Error('沒有台指期資料');
    const last = num(f.CLastPrice), ref = num(f.CRefPrice);
    return { name: f.DispCName || '台指期', last, ref, diff: ref ? last - ref : num(f.CDiff), pct: ref ? (last / ref - 1) * 100 : num(f.CDiffRate), time: f.CTime || null };
  } catch (e) { console.log('台指期夜盤讀取失敗：', e.message); return null; }
}

module.exports = { quotes, taifexNight };
