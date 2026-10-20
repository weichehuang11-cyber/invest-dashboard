'use strict';
/** 總經：CBOE 官方 VIX、美國財政部殖利率曲線（10Y、2Y、3M） */
const { get } = require('./http');

function csvRows(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = lines.shift().split(',').map(s => s.replace(/"/g, '').trim());
  return lines.map(l => { const v = l.split(','); return Object.fromEntries(head.map((h, i) => [h, (v[i] || '').replace(/"/g, '').trim()])); });
}

async function vix() {
  const rows = csvRows(await get('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv', { as: 'text', timeout: 20000 }));
  const a = rows[rows.length - 1], b = rows[rows.length - 2];
  const p = +a.CLOSE, q = +b.CLOSE;
  const d = a.DATE.split('/');          // MM/DD/YYYY
  return { price: p, prevClose: q, changePct: (p / q - 1) * 100, date: `${d[2]}-${d[0]}-${d[1]}`, series: rows.slice(-260).map(r => +r.CLOSE) };
}

async function treasury() {
  const y = new Date().getUTCFullYear();
  for (const yr of [y, y - 1]) {
    try {
      const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
        + `${yr}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`;
      const rows = csvRows(await get(url, { as: 'text', timeout: 20000 })).filter(r => r.Date);
      if (rows.length < 2) continue;
      const [a, b] = rows;               // 最新在前
      const pick = (r, k) => (r[k] !== '' && r[k] != null ? +r[k] : null);
      const d = a.Date.split('/');
      return {
        date: `${d[2]}-${d[0]}-${d[1]}`,
        y10: pick(a, '10 Yr'), y2: pick(a, '2 Yr'), m3: pick(a, '3 Mo'),
        y10Prev: pick(b, '10 Yr'), y2Prev: pick(b, '2 Yr'),
      };
    } catch (_) { /* 試前一年 */ }
  }
  return null;
}

module.exports = { vix, treasury, csvRows };
