'use strict';
/**
 * NAS 備援伺服器（取代舊的 invest 主程式）：零相依套件，pm2 常駐一個程序就好
 *   1. 提供備援網站與資料：http://NAS:8765/backup/（GitHub 網站資料過舊時會來這裡讀）
 *   2. 內建排程：盤中每 30 分鐘、台股收盤後 16:55、美股收盤後 05:45（台北時間）執行 nas/run-backup.sh
 *   3. 狀態：/backup/status.json
 *
 *   pm2 start /volume2/homes/invest-dashboard/nas/server.js --name signal-backup && pm2 save
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.resolve(__dirname, '..');
const BASE = process.env.INVEST_BACKUP_BASE || path.resolve(DIR, '..', 'invest-backup');
const SITE = path.join(BASE, 'site');
const PORT = +(process.env.PORT || 8765);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const state = { started: new Date().toISOString(), running: null, last: null, history: [] };

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
}, 20000);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' ) { res.writeHead(302, { Location: '/backup/' }); return res.end(); }
  if (url === '/backup/status.json' || url === '/health') { res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ status: 'ok', ...state })); }
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
