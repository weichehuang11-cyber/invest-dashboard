'use strict';
// 線上測試：上市融資金額與融資維持率（GitHub Actions「資料來源測試」執行，結果寫在執行摘要）
const Market = require('../lib/market');
const TWSE = require('../lib/twse');
(async () => {
  const note = t => console.log(`::notice title=融資維持率::${t}`);
  let d = TWSE.lastTradingDate();
  for (let k = 0; k < 6; k++) {
    const mi = await Market.miIndex(d).catch(e => ({ err: e.message }));
    const closes = mi?.closes || null;
    const m = await Market.twMargin(d, closes).catch(e => ({ err: e.message }));
    if (m && !m.err && m.balance) { note(`${d} 融資金額 ${m.balance.toFixed(1)} 億、維持率 ${m.ratio ?? '算不出來'}%（${m.n} 檔、收盤價 ${closes ? Object.keys(closes).length : 0} 檔）`); return; }
    note(`${d} 沒資料：${m?.err || mi?.err || '空'}`); d = TWSE.prevTradingDate(d);
    await new Promise(r => setTimeout(r, 1500));
  }
})();
