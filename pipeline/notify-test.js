'use strict';
/** 推播測試：在指定分鐘內，每隔幾秒送一則「範例通知」（用目前真實報價組成，標題標明【測試】） */
const fs = require('fs');
const { send } = require('./notify');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const minutes = +(args.minutes || 3), gap = +(args.gap || 20);
const snap = (() => { try { return JSON.parse(fs.readFileSync(String(args.snap || 'snapshot.json'), 'utf8')); } catch (_) { return null; } })();
const it = k => snap?.items?.[k] || { key: k, name: k, price: 0, changePct: 0 };
const fmt = v => (v >= 1000 ? Math.round(v).toLocaleString() : (+v).toFixed(v >= 100 ? 1 : 2));
const a = it('2330'), n = it('NVDA'), m = it('2454');
const samples = [
  ['🔔 價格提醒', `${a.key} ${a.name} 漲到 ${fmt(a.price)}（提醒價 ${fmt(a.price * 0.99)}）`, 4],
  ['📌 論點觸發', `${m.key} ${m.name} 論點條件觸發：跌破 20 日線、外資連賣 5 天（現價 ${fmt(m.price)}）`, 4],
  ['📉 持股大跌', `持股 ${n.key} ${n.name} −4.6%（${fmt(n.price)}）`, 3],
  ['🔄 訊號轉變', `${m.key} ${m.name} 轉為買進（分數 66，3 項證據同向）`, 3],
  ['🗓 持股財報', `持股 ${n.key} ${n.name} 財報明天`, 3],
  ['🧭 今日判斷', `今日判斷較前次轉弱：${snap?.verdict?.headline || '風險偏好偏空：降低持股、提高現金'}`, 3],
  ['🚨 市場警訊', 'VIX 期限結構倒掛（近月 28.4 > 三個月 26.1），市場處於急性恐慌', 4],
  ['💰 除權息', `持股 ${a.key} ${a.name} 明天除權息（現金 5 元）`, 2],
  ['🗓 總經事件', '明天：美國聯準會利率決議（FOMC）', 2],
];
(async () => {
  const total = Math.max(1, Math.floor(minutes * 60 / gap));
  let ok = 0;
  for (let i = 0; i < total; i++) {
    const [t, body, prio] = samples[i % samples.length];
    const sent = await send(`【測試 ${i + 1}/${total}】${t}`, [body, '', '這是測試通知，不是真實事件。'], { priority: prio, tags: ['test_tube'] });
    if (!sent) { console.log('沒有設定通知管道：請在 GitHub Secrets 新增 NTFY_TOPIC（或執行時輸入主題名稱）'); process.exit(1); }
    ok++;
    if (i < total - 1) await new Promise(r => setTimeout(r, gap * 1000));
  }
  console.log(`完成：共送出 ${ok} 則`);
})();
