'use strict';
/** 事件行事曆：設定檔的總經事件 ＋ 自動推算的固定日（結算、到期、月營收）＋ 觀察清單財報日 */
const nthWeekday = (y, m, wd, n) => { const d = new Date(Date.UTC(y, m, 1)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return d.toISOString().slice(0, 10); };

function build({ config = [], items = {}, today, days = 21 }) {
  const end = new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
  const out = config.filter(e => e.date >= today && e.date <= end).map(e => ({ ...e, kind: 'macro' }));
  const t = new Date(Date.parse(today));
  for (let k = 0; k < 2; k++) {
    const y = t.getUTCFullYear() + Math.floor((t.getUTCMonth() + k) / 12), m = (t.getUTCMonth() + k) % 12;
    out.push({ date: nthWeekday(y, m, 3, 3), title: '台指期、台指選擇權月結算', region: 'tw', importance: 2, kind: 'expiry' });
    out.push({ date: nthWeekday(y, m, 5, 3), title: '美股月選擇權到期', region: 'us', importance: 1, kind: 'expiry' });
    out.push({ date: `${y}-${String(m + 1).padStart(2, '0')}-10`, title: '台股上市櫃公司月營收公布截止', region: 'tw', importance: 1, kind: 'revenue' });
  }
  for (const it of Object.values(items)) {
    const d = it.fund?.earningsDate;
    if (d && d >= today && d <= end) out.push({ date: d, title: `${it.key} ${it.name} 財報`, region: it.market, importance: 2, kind: 'earnings', key: it.key });
    const x = it.fund?.exDividendDate;
    if (x && x >= today && x <= end) out.push({ date: x, title: `${it.key} ${it.name} 除${it.fund.exDividendType && /權/.test(it.fund.exDividendType) && !/息/.test(it.fund.exDividendType) ? '權' : '息'}${it.fund.exDividendCash ? `（現金 ${it.fund.exDividendCash} 元）` : ''}`, region: it.market, importance: 1, kind: 'exdiv', key: it.key });
  }
  return out.filter(e => e.date >= today && e.date <= end).sort((a, b) => a.date.localeCompare(b.date) || b.importance - a.importance);
}
module.exports = { build, nthWeekday };
