'use strict';
// 線上測試：FinMind 個股融資融券（TaiwanStockMarginPurchaseShortsale）能不能抓到；抓不到時印出 FinMind 回的錯誤訊息
const FinMind = require('../lib/finmind');
(async () => {
  const note = t => console.log(`::notice title=FinMind 個股融資::${t}`);
  const token = process.env.FINMIND_TOKEN || '';
  if (!token) return note('沒有設定 FINMIND_TOKEN');
  for (const id of ['2330', '2317']) {
    try { const m = await FinMind.margin(id, token, 14); const a = m[m.length - 1]; note(a ? `${id} ${m.length} 筆，最新 ${a.date} 融資 ${a.margin} 張、融券 ${a.short} 張` : `${id} 回應成功但沒有資料`); }
    catch (e) { note(`${id} 失敗：${e.message}`); }
    await new Promise(r => setTimeout(r, 1000));
  }
})();
