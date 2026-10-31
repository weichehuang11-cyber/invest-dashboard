'use strict';
/**
 * 是否為交易日
 *   美股：依紐約證交所規則推算（元旦、MLK、總統日、耶穌受難日、陣亡將士、六月節、獨立紀念日、勞動節、感恩節、聖誕節）
 *   台股：證交所公開資料「開（休）市日期」；抓不到時只排除週末
 *
 *   node pipeline/lib/holidays.js tw [YYYY-MM-DD]   → 印出 open 或 closed
 */
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = s => new Date(s + 'T00:00:00Z').getUTCDay();
function nth(y, m, wd, n) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return ymd(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7); }
function lastWd(y, m, wd) { const last = new Date(Date.UTC(y, m, 0)); const d = last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7); return ymd(y, m, d); }
function observed(y, m, d) { const s = ymd(y, m, d), w = dow(s); const t = Date.UTC(y, m - 1, d) + (w === 6 ? -1 : w === 0 ? 1 : 0) * 86400000; return new Date(t).toISOString().slice(0, 10); }
function easter(y) {   // 西方復活節（Anonymous Gregorian）
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
function usHolidays(y) {
  const s = new Set([
    nth(y, 1, 1, 3), nth(y, 2, 1, 3), new Date(easter(y) - 2 * 86400000).toISOString().slice(0, 10), lastWd(y, 5, 1),
    observed(y, 7, 4), nth(y, 9, 1, 1), nth(y, 11, 4, 4), observed(y, 12, 25),
  ]);
  if (y >= 2022) s.add(observed(y, 6, 19));
  const ny = ymd(y, 1, 1); if (dow(ny) !== 6) s.add(observed(y, 1, 1));   // 元旦逢週六不補假（紐約證交所規則）
  return s;
}

async function twHolidays() {
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const out = new Set();
    for (const x of await r.json()) {
      const raw = String(x.Date || x.date || '').replace(/\D/g, ''); if (raw.length < 7) continue;
      const y = +raw.slice(0, raw.length - 4) + 1911, md = raw.slice(-4), d = `${y}-${md.slice(0, 2)}-${md.slice(2)}`;
      const txt = `${x.Name || ''}${x.Description || ''}`;
      if (/開始交易|最後交易/.test(txt) && !/無交易/.test(txt)) continue;   // 這些是「有交易」的特殊日
      out.add(d);
    }
    return out;
  } catch (e) { console.error('台股休市日讀取失敗，只排除週末：', e.message); return null; }
}

async function isTradingDay(market, day) {
  const w = dow(day); if (w === 0 || w === 6) return false;
  if (market === 'us') return !usHolidays(+day.slice(0, 4)).has(day);
  const tw = await twHolidays();
  return !(tw && tw.has(day));
}

module.exports = { isTradingDay, usHolidays, twHolidays };
if (require.main === module) (async () => {
  const mk = process.argv[2] === 'us' ? 'us' : 'tw';
  const day = process.argv[3] || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  console.log((await isTradingDay(mk, day)) ? 'open' : 'closed');
})();
