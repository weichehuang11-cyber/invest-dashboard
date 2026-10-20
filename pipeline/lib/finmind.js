'use strict';
/**
 * FinMind（需要 FINMIND_TOKEN）：台股法人歷史（含上櫃）與月營收。
 * 法人名稱為英文：Foreign_Investor / Foreign_Dealer_Self / Investment_Trust / Dealer_self / Dealer_Hedging
 */
const { get } = require('./http');
const BASE = 'https://api.finmindtrade.com/api/v4/data';
const KIND = {
  Foreign_Investor: 'foreign', Foreign_Dealer_Self: 'foreign', '外資': 'foreign', '外資及陸資': 'foreign',
  Investment_Trust: 'trust', '投信': 'trust',
  Dealer_self: 'dealer', Dealer_Hedging: 'dealer', Dealer: 'dealer', '自營商': 'dealer',
};
const since = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

async function dataset(ds, id, days, token) {
  const url = `${BASE}?dataset=${ds}&data_id=${encodeURIComponent(id)}&start_date=${since(days)}&token=${encodeURIComponent(token)}`;
  const j = await get(url, { timeout: 20000 });
  if (j?.status !== 200) throw new Error('FinMind ' + (j?.msg || j?.status));
  return j.data || [];
}

/** 法人每日淨買賣（張 = 股/1000），舊→新 */
async function institutional(id, token, days = 60) {
  const rows = await dataset('TaiwanStockInstitutionalInvestorsBuySell', id, days, token);
  const by = {};
  for (const r of rows) {
    const k = KIND[r.name]; if (!k) continue;
    const d = String(r.date).slice(0, 10);
    by[d] = by[d] || { date: d, foreign: 0, trust: 0, dealer: 0 };
    by[d][k] += ((Number(r.buy) || 0) - (Number(r.sell) || 0)) / 1000;
  }
  return Object.values(by).sort((a, b) => a.date.localeCompare(b.date))
    .map(x => ({ ...x, total: x.foreign + x.trust + x.dealer }));
}

/** 月營收年增率（自行對到去年同月） */
async function revenueYoY(id, token) {
  const rows = await dataset('TaiwanStockMonthRevenue', id, 800, token);
  const key = r => `${r.revenue_year}-${String(r.revenue_month).padStart(2, '0')}`;
  const map = Object.fromEntries(rows.map(r => [key(r), +r.revenue]));
  const sorted = rows.slice().sort((a, b) => key(b).localeCompare(key(a)));
  const r = sorted[0];
  if (!r) return null;
  const ly = map[`${r.revenue_year - 1}-${String(r.revenue_month).padStart(2, '0')}`];
  return { period: key(r), revenue: +r.revenue, yoy: ly > 0 ? (r.revenue / ly - 1) * 100 : null };
}

/** 融資融券餘額（舊→新）：{date, margin, short} */
async function margin(id, token, days = 30) {
  const rows = await dataset('TaiwanStockMarginPurchaseShortsale', id, days, token);
  return rows.map(r => ({ date: String(r.date).slice(0, 10), margin: +r.MarginPurchaseTodayBalance || 0, short: +r.ShortSaleTodayBalance || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function consecutive(hist, k = 'foreign') {
  if (!hist?.length) return 0;
  const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const s = sign(hist[hist.length - 1][k]);
  if (!s) return 0;
  let n = 0;
  for (let i = hist.length - 1; i >= 0 && sign(hist[i][k]) === s; i--) n++;
  return s * n;
}
const sum = (hist, k, n) => hist.slice(-n).reduce((s, x) => s + (x[k] || 0), 0);

module.exports = { institutional, revenueYoY, margin, consecutive, sum, KIND };
