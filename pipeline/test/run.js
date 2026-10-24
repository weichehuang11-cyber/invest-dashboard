'use strict';
// 用模擬資料跑一次完整更新與一次盤中更新，檢查輸出結構（不連網）
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
const run = extra => execFileSync(process.execPath, ['-r', path.join(__dirname, 'mock-fetch.js'), path.join(__dirname, '..', 'build.js'), `--out=${tmp}/out`, `--state=${tmp}/state`, ...extra], { env: { ...process.env, FINMIND_TOKEN: 'test' }, stdio: 'pipe' });
run(['--full=all']);
run([]);
const s = JSON.parse(fs.readFileSync(`${tmp}/out/snapshot.json`, 'utf8'));
assert(s.verdict && s.verdict.headline, '缺少今日判斷');
assert(s.env.length >= 6, '市場環境不足');
{ const w = JSON.parse(fs.readFileSync(require('path').join(__dirname, '../../config/watchlist.json'), 'utf8')); assert(Object.keys(s.items).length === w.us.length + w.tw.length, '個股數量不對'); }
for (const it of Object.values(s.items)) {
  assert(['BUY', 'SELL', 'HOLD'].includes(it.signal.sig), it.key + ' 訊號錯誤');
  assert(Number.isFinite(it.price) && Number.isFinite(it.changePct), it.key + ' 報價錯誤');
  assert(it.ta && Number.isFinite(it.ta.rsi), it.key + ' 缺少指標');
  assert(fs.existsSync(`${tmp}/out/bars/${it.key}.json`), it.key + ' 缺少日 K 檔');
}
assert(s.items['2330'].chip && Number.isFinite(s.items['2330'].chip.foreign5), '台股籌碼錯誤');
assert(s.sectors.length === 11, '板塊數量不對');
assert(fs.existsSync(`${tmp}/state/predictions.json`), '沒有寫入預測紀錄');
console.log('全部通過', JSON.stringify({ verdict: s.verdict.headline, items: Object.keys(s.items).length, changes: s.changes.length }));
