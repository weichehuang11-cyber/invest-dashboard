'use strict';
/**
 * 由 GitHub Issue 標題修改觀察清單：
 *   「加入觀察清單 2603」「加入 NVDA」「移除觀察清單 2603」
 * 驗證代號在 Yahoo 有日 K（台股自動試上市 .TW／上櫃 .TWO），寫回 config/watchlist.json。
 * 結果訊息寫到 stdout 最後一行（JSON），供 workflow 回覆在 issue。
 */
const fs = require('fs');
const path = require('path');
const Yahoo = require('./lib/yahoo');

(async () => {
  const title = String(process.argv[2] || '');
  const file = path.join(__dirname, '..', 'config', 'watchlist.json');
  const wl = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = title.match(/(加入|新增|add|移除|刪除|remove)[^A-Za-z0-9^]*([A-Za-z0-9.^\-]+)/i);
  const done = (ok, msg, changed = false) => { console.log(JSON.stringify({ ok, msg, changed })); process.exit(0); };
  if (!m) done(false, '看不懂標題。格式：「加入觀察清單 2603」或「移除觀察清單 2603」。');
  const add = /加入|新增|add/i.test(m[1]);
  let key = m[2].toUpperCase().replace(/\.TWO?$/, '');
  const market = /^\d{4,6}[A-Z]?$/.test(key) ? 'tw' : 'us';
  const list = wl[market];
  if (!add) {
    if (!list.includes(key)) done(false, `${key} 不在觀察清單。`);
    wl[market] = list.filter(x => x !== key); delete wl.names[key];
    fs.writeFileSync(file, JSON.stringify(wl, null, 2) + '\n');
    done(true, `已從觀察清單移除 ${key}。網站約 3 分鐘後更新。`, true);
  }
  if (list.includes(key)) done(false, `${key} 已經在觀察清單。`);
  if (wl.us.length + wl.tw.length >= 60) done(false, '觀察清單已達 60 檔上限（太多會拖慢每次更新），請先移除一些。');
  const d = await Yahoo.daily(key, '1mo').catch(() => null);
  if (!d) done(false, `找不到 ${key} 的報價，請確認代號。`);
  let name = String(process.argv[3] || '').trim() || d.name || key;
  wl[market].push(key); wl.names[key] = name;
  fs.writeFileSync(file, JSON.stringify(wl, null, 2) + '\n');
  done(true, `已加入觀察清單：${key} ${name}（${d.yahoo}，現價 ${Math.round(d.price * 100) / 100}）。網站約 3～5 分鐘後會出現完整分析。`, true);
})();
