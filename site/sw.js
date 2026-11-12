// 訊號終端：加到主畫面後的離線支援。一律先上網拿最新的；沒網路才用上次存下來的（網頁與資料）。
const CACHE = 'signal-v1';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html', './app.js', './app.css', './manifest.webmanifest', './icon-192.png']).catch(() => {}))); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url); if (u.origin !== location.origin) return;   // 只處理自己的網站（NAS、GitHub API 不碰）
  e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match('./index.html'))));
});
