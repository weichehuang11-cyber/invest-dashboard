'use strict';
/**
 * 台股補充資料
 *   revenueAll()   上市＋上櫃全部公司的月營收（證交所／櫃買中心開放資料）：當月、月增、年增、累計年增
 *   sbl(id)        借券賣出（FinMind）
 *   confCalls()    法說會：用 AI 搜尋整理近期（前 14 天～後 21 天）的法說會日期與重點
 */
const { get } = require('./http');
const r2 = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const pick = (o, ...pats) => { for (const k of Object.keys(o)) if (pats.some(p => p.test(k))) return o[k]; return undefined; };

async function revenueAll() {
  const urls = ['https://openapi.twse.com.tw/v1/opendata/t187ap05_L', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O'];
  const rows = {}; let period = null; const errs = [];
  for (const u of urls) {
    try {
      const arr = await get(u, { timeout: 30000 });
      for (const x of Array.isArray(arr) ? arr : []) {
        const k = String(pick(x, /公司代號/) || '').trim(); if (!/^\d{4}$/.test(k)) continue;
        const ym = String(pick(x, /資料年月/) || '').trim();   // 民國年月，例如 11510
        const p = ym.length >= 5 ? `${+ym.slice(0, ym.length - 2) + 1911}-${ym.slice(-2)}` : null; if (p && (!period || p > period)) period = p;
        rows[k] = { n: String(pick(x, /公司名稱/) || '').trim(), p, rev: num(pick(x, /當月營收/)), mom: r2(num(pick(x, /上月比較增減/))), yoy: r2(num(pick(x, /去年同月增減/))), cum: r2(num(pick(x, /前期比較增減/))) };
      }
    } catch (e) { errs.push(`${u.includes('tpex') ? '上櫃' : '上市'}：${e.message}`); }
  }
  return { period, rows, errs };
}

async function sbl(id, token) {
  if (!token) return null;
  const start = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const j = await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanDailyShortSaleBalances&data_id=${id}&start_date=${start}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
  const d = (j?.data || []).map(r => ({ date: String(r.date).slice(0, 10), bal: num(r.SBLShortSalesCurrentDayBalance), sell: num(r.SBLShortSalesShortSales) })).filter(r => r.bal != null).sort((a, b) => a.date.localeCompare(b.date));
  if (d.length < 2) return null;
  const last = d[d.length - 1], ago = d[Math.max(0, d.length - 6)];
  return { date: last.date, bal: last.bal, sell5: d.slice(-5).reduce((a, r) => a + (r.sell || 0), 0), chg5: ago.bal > 0 ? r2((last.bal / ago.bal - 1) * 100) : null };
}

/** 法說會：AI 用 Google 搜尋整理；只回傳查得到可靠來源的 */
async function confCalls(list, AI) {
  if (!list.length) return [];
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const prompt = `今天是 ${today}。請用 Google 搜尋，找出下列台灣上市櫃公司在 ${today} 前 14 天到後 21 天之間的法人說明會（法說會）：
${list.map(x => `${x.k} ${x.n}`).join('、')}
已經開過的，請整理 2～3 點重點（營收展望、毛利率、資本支出、產能或需求）；還沒開的只要日期。查不到可靠來源（公開資訊觀測站、公司官網、主要財經媒體）的公司不要列。
只輸出 JSON 陣列：[{"k":"代號","date":"YYYY-MM-DD","held":true 或 false,"points":["重點1","重點2"],"source":"來源網站名稱"}]`;
  const t = await AI.grounded(prompt, '你是台股研究助理，用繁體中文，只根據搜尋到的可靠來源，不要猜測日期。');
  const arr = JSON.parse((String(t).match(/\[[\s\S]*\]/) || ['[]'])[0]);
  const names = Object.fromEntries(list.map(x => [x.k, x.n]));
  return arr.filter(x => names[String(x.k)] && /^\d{4}-\d{2}-\d{2}$/.test(x.date)).map(x => ({ k: String(x.k), n: names[String(x.k)], date: x.date, held: !!x.held && x.date <= today, points: (x.points || []).slice(0, 3).map(String), source: String(x.source || '') }));
}

module.exports = { revenueAll, sbl, confCalls };
if (require.main === module) (async () => {
  const r = await revenueAll(); console.log(`::notice::月營收 ${r.period} ${Object.keys(r.rows).length} 家 ${r.errs.join('；')} 例 2330=${JSON.stringify(r.rows['2330'])} 3189=${JSON.stringify(r.rows['3189'])}`);
  const s = await sbl('2330', process.env.FINMIND_TOKEN).catch(e => 'ERR ' + e.message); console.log(`::notice::借券 2330 ${JSON.stringify(s)}`);
})();
