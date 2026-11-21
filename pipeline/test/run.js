'use strict';
// 用模擬資料跑一次完整更新與一次盤中更新，檢查輸出結構（不連網）
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
const run = (extra, env = {}) => execFileSync(process.execPath, ['-r', path.join(__dirname, 'mock-fetch.js'), path.join(__dirname, '..', 'build.js'), `--out=${tmp}/out`, `--state=${tmp}/state`, ...extra], { env: { ...process.env, FINMIND_TOKEN: 'test', ...env }, stdio: 'pipe' });
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
// 資料健康：last.json 分市場保存狀態、估值不重複記同一天、FinMind 個股融資失敗時改用證交所
{
  const L = JSON.parse(fs.readFileSync(`${tmp}/state/last.json`, 'utf8'));
  assert(L.statusBy?.tw?.at && L.statusBy?.us?.at, 'last.json 缺少 statusBy');
  assert(/^\d+\/\d+$/.test(L.statusBy.tw.finmindMargin), 'FinMind 融資狀態錯誤：' + L.statusBy.tw.finmindMargin);
  run(['--full=tw'], { MOCK_FM_MARGIN_FAIL: '1' });
  const L2 = JSON.parse(fs.readFileSync(`${tmp}/state/last.json`, 'utf8')), H = JSON.parse(fs.readFileSync(`${tmp}/state/heavy.json`, 'utf8'));
  assert(/^fail: .*mock.*改用證交所 \d+ 檔/.test(L2.status.finmindMargin), '融資備援狀態錯誤：' + L2.status.finmindMargin);
  assert(L2.statusBy.us.at === L.statusBy.us.at, '台股更新不該覆蓋美股狀態');
  assert(H.tw.finmind['2330'].margin.length >= 1 && H.tw.marginStock['2330'][0].margin > 0, '證交所個股融資備援沒寫入');
  const vh = H.tw.valHist; assert(vh.every((x, i) => i === 0 || x.pe !== vh[i - 1].pe || x.n !== vh[i - 1].n || x.dy !== vh[i - 1].dy), '估值有重複的日子');
}
console.log('全部通過', JSON.stringify({ verdict: s.verdict.headline, items: Object.keys(s.items).length, changes: s.changes.length }));
