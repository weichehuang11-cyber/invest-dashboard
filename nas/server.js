'use strict';
/**
 * NAS 備援伺服器（取代舊的 invest 主程式）：零相依套件，pm2 常駐一個程序就好
 *   1. 提供備援網站與資料：http://NAS:8765/backup/（GitHub 網站資料過舊時會來這裡讀）
 *   2. 內建排程：盤中每 30 分鐘、台股收盤後 16:55、美股收盤後 05:45（台北時間）執行 nas/run-backup.sh
 *   3. 狀態：/backup/status.json
 *   4. 監看 GitHub 排程：盤中網站資料超過 60 分鐘沒更新，就推播提醒並自動觸發一次 GitHub 更新
 *      （設定檔 nas/.env：NTFY_TOPIC=…、GH_TOKEN=…（只需 invest-dashboard 的 Actions 讀寫權限））
 *
 *   pm2 start /volume2/homes/invest-dashboard/nas/server.js --name signal-backup && pm2 save
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.resolve(__dirname, '..');
const BASE = process.env.INVEST_BACKUP_BASE || path.resolve(DIR, '..', 'invest-backup');
const SITE = path.join(BASE, 'site');
const ARCH = path.join(BASE, 'archive');
const PORT = +(process.env.PORT || 8765);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const state = { started: new Date().toISOString(), running: null, last: null, history: [], watch: { checkedAt: null, ageMin: null, lastAlert: null, lastDispatch: null, note: null } };

// ── 設定檔 nas/.env（不進 Git）─────────────────────────────────
const ENV = {};
try { for (const line of fs.readFileSync(path.join(DIR, 'nas', '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (_) {}
const OWNER = 'weichehuang11-cyber', REPO = 'invest-dashboard';
function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers: { 'User-Agent': 'signal-nas', ...headers }, timeout: 20000 }, res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); if (body) r.write(body); r.end();
  });
}
async function ntfy(title, msg) {
  if (!ENV.NTFY_TOPIC) return false;
  const r = await req('POST', 'https://ntfy.sh', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: ENV.NTFY_TOPIC, title, message: msg, priority: 3, tags: ['satellite'] }) });
  return r.status < 300;
}
async function dispatch() {
  if (!ENV.GH_TOKEN) return 'no-token';
  const r = await req('POST', `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/update.yml/dispatches`, { headers: { Authorization: `Bearer ${ENV.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' }) });
  return r.status === 204 ? 'ok' : `HTTP ${r.status}`;
}
/** 盤中（台股 09:30–13:40、美股 22:00–04:50，台北時間）每 15 分鐘檢查 GitHub 網站資料新不新 */
async function watchGithub() {
  const t = new Date(Date.now() + 8 * 3600000), wd = t.getUTCDay(), hm = t.getUTCHours() * 60 + t.getUTCMinutes();
  const open = (wd >= 1 && wd <= 5 && hm >= 570 && hm <= 820) || (wd >= 1 && wd <= 5 && hm >= 1320) || (wd >= 2 && wd <= 6 && hm <= 290);
  if (!open) return;
  try {
    const r = await req('GET', `https://${OWNER}.github.io/${REPO}/data/snapshot.json?t=${Date.now()}`);
    const gen = JSON.parse(r.body).generatedAt, age = (Date.now() - Date.parse(gen)) / 60000;
    Object.assign(state.watch, { checkedAt: new Date().toISOString(), ageMin: Math.round(age) });
    if (age > 60 && (!state.watch.lastAlert || Date.now() - Date.parse(state.watch.lastAlert) > 90 * 60000)) {
      const d = await dispatch();
      state.watch.lastAlert = new Date().toISOString(); state.watch.lastDispatch = d;
      await ntfy('GitHub 排程延遲', `網站資料已 ${Math.round(age)} 分鐘沒更新。${d === 'ok' ? 'NAS 已自動觸發一次更新，約 5 分鐘後恢復。' : d === 'no-token' ? '（NAS 沒有設定 GH_TOKEN，無法自動觸發）' : `自動觸發失敗：${d}`}這段期間網站會自動改讀 NAS 備援資料。`);
      console.log(new Date().toISOString(), 'GitHub 資料過舊', Math.round(age), '分鐘，觸發：', d);
    }
  } catch (e) { state.watch.note = '檢查失敗：' + e.message; }
}

function run(mode) {
  if (state.running) return;
  const t0 = Date.now();
  state.running = { mode: mode || 'intraday', at: new Date().toISOString() };
  const p = spawn('bash', [path.join(DIR, 'nas', 'run-backup.sh'), ...(mode ? [mode] : [])], { cwd: DIR, env: process.env });
  p.on('close', code => {
    state.last = { mode: mode || 'intraday', at: state.running.at, ok: code === 0, seconds: Math.round((Date.now() - t0) / 1000) };
    state.history = [state.last, ...state.history].slice(0, 50);
    state.running = null;
    console.log(new Date().toISOString(), '備援更新', state.last);
  });
}

// 每分鐘檢查一次（台北時間）
let lastSlot = '';
setInterval(() => {
  const t = new Date(Date.now() + 8 * 3600000), wd = t.getUTCDay(), h = t.getUTCHours(), m = t.getUTCMinutes();
  const hm = h * 60 + m, slot = `${t.toISOString().slice(0, 13)}:${m}`;
  if (slot === lastSlot) return; lastSlot = slot;
  if (wd >= 1 && wd <= 5 && hm === 16 * 60 + 55) return run('tw');
  if (wd >= 2 && wd <= 6 && hm === 5 * 60 + 45) return run('us');
  const twOpen = wd >= 1 && wd <= 5 && hm >= 9 * 60 && hm <= 13 * 60 + 40;
  const usOpen = (wd >= 1 && wd <= 5 && hm >= 21 * 60 + 30) || (wd >= 2 && wd <= 6 && hm <= 5 * 60);
  if ((twOpen || usOpen) && (m === 10 || m === 40)) run();
  if (m % 15 === 5) watchGithub();
}, 20000);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' ) { res.writeHead(302, { Location: '/backup/' }); return res.end(); }
  if (url === '/backup/status.json' || url === '/health') { res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ status: 'ok', ...state })); }
  // 歷史封存：盤中每次更新的快照（網站「歷史快照」頁可選時間查詢）
  if (url === '/backup/archive/index.json') {
    let days = [];
    try { days = fs.readdirSync(path.join(ARCH, 'snapshots')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().map(d => ({ d, t: fs.readdirSync(path.join(ARCH, 'snapshots', d)).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4)).sort() })); } catch (_) {}
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ days }));
  }
  const am = url.match(/^\/backup\/archive\/(snapshots\/\d{4}-\d{2}-\d{2}\/\d{4}|daily\/\d{4}-\d{2}-\d{2})\.json$/);
  if (am) return fs.readFile(path.join(ARCH, am[1] + '.json'), (err, buf) => { if (err) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'public, max-age=86400' }); res.end(buf); });
  if (!url.startsWith('/backup/')) { res.writeHead(404); return res.end('not found'); }
  let f = path.normalize(path.join(SITE, url.slice('/backup/'.length)));
  if (!f.startsWith(SITE)) { res.writeHead(403); return res.end(); }
  if (f.endsWith(path.sep) || f === SITE) f = path.join(f, 'index.html');
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': /\.json$/.test(f) ? 'no-store' : 'max-age=300' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`備援伺服器 http://0.0.0.0:${PORT}/backup/  資料夾 ${SITE}`));

// 啟動時若還沒有資料就先跑一次完整更新
if (!fs.existsSync(path.join(SITE, 'data', 'snapshot.json'))) run('all');
