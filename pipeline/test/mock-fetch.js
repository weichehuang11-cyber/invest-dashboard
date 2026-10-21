'use strict';
/**
 * 測試用：以合成資料取代網路（node -r pipeline/test/mock-fetch.js pipeline/build.js ...）
 * 回應格式依各資料源的真實格式（Yahoo v8 chart、CBOE CSV、財政部 CSV、TWSE T86/MI_INDEX、FinMind）。
 */
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

function weekdays(n, endMs = Date.now()) {
  const out = [];
  for (let t = endMs; out.length < n; t -= 86400000) { const w = new Date(t).getUTCDay(); if (w && w < 6) out.unshift(Math.floor(t / 1000)); }
  return out;
}
function yahoo(sym) {
  const tw = /\.TWO?$/.test(sym);
  if (sym.endsWith('.TW') && /^(6488)/.test(sym)) return { chart: { result: null, error: { code: 'Not Found' } } };
  const days = weekdays(500).map(t => t - (t % 86400) + (tw ? 1 * 3600 : 14 * 3600));
  let p = 20 + Math.abs(hash(sym)) % 500;
  const o = [], h = [], l = [], c = [], v = [];
  for (let i = 0; i < days.length; i++) { const op = p; p *= 1 + (rnd() - 0.49) * 0.03; o.push(op); c.push(p); h.push(Math.max(op, p) * 1.006); l.push(Math.min(op, p) * 0.994); v.push(Math.round(5e6 * (0.5 + rnd()))); }
  return { chart: { result: [{ meta: { symbol: sym, currency: tw ? 'TWD' : 'USD', gmtoffset: tw ? 28800 : -14400, regularMarketPrice: c[c.length - 1], regularMarketTime: days[days.length - 1], shortName: sym, chartPreviousClose: c[0] }, timestamp: days, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] } }] } };
}
const vixCsv = () => 'DATE,OPEN,HIGH,LOW,CLOSE\n' + Array.from({ length: 300 }, (_, i) => `10/${String(1 + (i % 28)).padStart(2, '0')}/2026,1,1,1,${(18 + Math.sin(i / 7) * 3).toFixed(2)}`).join('\n') + '\n10/16/2026,1,1,1,19.40\n10/17/2026,1,1,1,21.40';
const tsyCsv = () => 'Date,"1 Mo","2 Mo","3 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"\n10/16/2026,3.9,3.9,3.88,3.8,3.7,3.55,3.58,3.7,3.85,3.97,4.5,4.6\n10/15/2026,3.9,3.9,3.88,3.8,3.7,3.56,3.58,3.7,3.85,3.95,4.5,4.6';
const T86_FIELDS = ['證券代號', '證券名稱', '外陸資買進股數(不含外資自營商)', '外陸資賣出股數(不含外資自營商)', '外陸資買賣超股數(不含外資自營商)', '外資自營商買進股數', '外資自營商賣出股數', '外資自營商買賣超股數', '投信買進股數', '投信賣出股數', '投信買賣超股數', '自營商買賣超股數', '自營商買進股數(自行買賣)', '自營商賣出股數(自行買賣)', '自營商買賣超股數(自行買賣)', '自營商買進股數(避險)', '自營商賣出股數(避險)', '自營商買賣超股數(避險)', '三大法人買賣超股數'];
function t86() {
  const ids = ['2330', '2317', '2454', '2382', '2303', '2308', '2881', '2891', '2886', '3008', ...Array.from({ length: 150 }, (_, i) => String(1101 + i))];
  return { stat: 'OK', fields: T86_FIELDS, data: ids.map(id => { const f = Math.round((rnd() - 0.55) * 2e7), t = Math.round((rnd() - 0.4) * 3e6), d = Math.round((rnd() - 0.5) * 1e6); return [id, '股' + id, '0', '0', f.toLocaleString(), '0', '0', '0', '0', '0', t.toLocaleString(), d.toLocaleString(), '0', '0', '0', '0', '0', '0', (f + t + d).toLocaleString()]; }) };
}
function miIndex(u) {
  const dt = +(u?.searchParams.get('date') || 0) % 997;
  const ids = ['2330', '2317', '2454', '2382', '2303', '2308', '2881', '2891', '2886', '3008', ...Array.from({ length: 150 }, (_, i) => String(1101 + i))];
  return { stat: 'OK', tables: [{ title: '價格指數', fields: [], data: [] }, { title: '114年 每日收盤行情(全部)', fields: ['證券代號', '證券名稱', '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌(+/-)', '漲跌價差'], data: ids.map(id => [id, '股' + id, '1', '1', '1', '1', '1', '1', ((50 + Math.abs(hash(id)) % 900) * (1 + Math.sin(dt / 9 + Math.abs(hash(id)) % 7) * 0.05)).toFixed(2), '<p style= color:red>+</p>', '1.00']) },
    { title: '漲跌證券數合計', fields: ['類型', '整體市場', '股票'], data: [['上漲(漲停)', '5,100(80)', `${400 + dt % 300}(12)`], ['下跌(跌停)', '4,000(10)', `${500 - dt % 200}(3)`], ['持平', '900', '120'], ['未成交', '10', '5'], ['無比價', '20', '8']] }] };
}
function finmind(u) {
  const ds = u.searchParams.get('dataset'), id = u.searchParams.get('data_id');
  const days = weekdays(45).map(t => new Date(t * 1000).toISOString().slice(0, 10));
  if (ds === 'TaiwanStockInstitutionalInvestorsBuySell') return { status: 200, msg: 'success', data: days.flatMap(d => ['Foreign_Investor', 'Foreign_Dealer_Self', 'Investment_Trust', 'Dealer_self', 'Dealer_Hedging'].map(name => ({ date: d, stock_id: id, name, buy: Math.round(rnd() * 3e6), sell: Math.round(rnd() * 3e6) }))) };
  if (ds === 'TaiwanStockMonthRevenue') return { status: 200, msg: 'success', data: Array.from({ length: 26 }, (_, i) => { const y = 2024 + Math.floor((i + 8) / 12), m = ((i + 8) % 12) + 1; return { date: `${y}-${String(m).padStart(2, '0')}-01`, stock_id: id, revenue: 1e10 * (1 + i * 0.02), revenue_month: m, revenue_year: y }; }) };
  if (ds === 'TaiwanStockMarginPurchaseShortsale') return { status: 200, msg: 'success', data: days.slice(-10).map((d, i) => ({ date: d, stock_id: id, MarginPurchaseTodayBalance: 20000 + i * 100, ShortSaleTodayBalance: 1500 + i * 10 })) };
  return { status: 400, msg: 'unknown dataset' };
}

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  const ok = (body, type = 'json') => new Response(type === 'json' ? JSON.stringify(body) : body, { status: 200, headers: { 'content-type': type === 'json' ? 'application/json' : 'text/csv' } });
  if (u.hostname.endsWith('finance.yahoo.com') && u.pathname.includes('/v8/finance/chart/')) return ok(yahoo(decodeURIComponent(u.pathname.split('/').pop())));
  if (u.hostname === 'cdn.cboe.com') return ok(vixCsv(), 'text');
  if (u.hostname === 'home.treasury.gov') return ok(tsyCsv(), 'text');
  if (u.hostname === 'www.twse.com.tw' && u.pathname.includes('T86')) return ok(t86());
  if (u.hostname === 'www.twse.com.tw' && u.pathname.includes('MI_INDEX')) return ok(miIndex(u));
  if (u.hostname === 'www.twse.com.tw' && u.pathname.includes('MI_MARGN')) return ok({ stat: 'OK', tables: [{ title: '信用交易統計', fields: ['項目', '買進', '賣出', '現金(券)償還', '前日餘額', '今日餘額'], data: [['融資(交易單位)', '1', '1', '1', '8,000,000', '8,010,000'], ['融券(交易單位)', '1', '1', '1', '300,000', '301,000'], ['融資金額(仟元)', '1', '1', '1', '345,600,000', '347,100,000']] }] });
  if (u.hostname === 'openapi.twse.com.tw') return ok(['2330', '2317', '2454', ...Array.from({ length: 300 }, (_, i) => String(1101 + i))].map(c => ({ Code: c, Name: 'x', PEratio: (10 + Math.abs(hash(c)) % 30).toFixed(2), DividendYield: '3.10', PBratio: '1.80' })));
  if (u.hostname === 'openapi.taifex.com.tw' && u.pathname.includes('FuturesContracts')) return ok('\uFEFF' + JSON.stringify([{ '日期': '20261020', '商品名稱': '臺股期貨', '身份別': '自營商', '多空未平倉口數淨額': '1,234' }, { '日期': '20261020', '商品名稱': '臺股期貨', '身份別': '外資及陸資', '多空未平倉口數淨額': '-35,678' }]), 'text');
  if (u.hostname === 'openapi.taifex.com.tw' && u.pathname.includes('PutCall')) return ok(Array.from({ length: 20 }, (_, i) => ({ Date: `202609${String(10 + i).padStart(2, '0')}`, PutVolume: '1', CallVolume: '1', 'PutCallVolumeRatio%': '95.5', PutOI: '1', CallOI: '1', 'PutCallOIRatio%': String(110 + i) })));
  if (u.hostname === 'fred.stlouisfed.org') { const id = u.searchParams.get('id'); return ok('observation_date,' + id + '\n' + Array.from({ length: 300 }, (_, i) => `${new Date(Date.now() - (300 - i) * 86400000).toISOString().slice(0, 10)},${(3 + Math.sin(i / 20)).toFixed(2)}`).join('\n'), 'text'); }
  if (u.hostname === 'api.finmindtrade.com') return ok(finmind(u));
  return new Response('blocked in test', { status: 404 });
};
global.__realFetch = realFetch;
