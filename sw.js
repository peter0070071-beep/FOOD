/* Maison Doré PWA service worker：離線可開啟、圖片與外部資源快取 */
const VERSION = 'md-v3';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 訂單 API（Google Apps Script）一律直連，不快取，避免拿到舊的菜單或狀態
  if (/(^|\.)script\.google\.com$|googleusercontent\.com$/.test(url.hostname)) return;
  // 影片分段請求不快取
  if (req.headers.has('range')) return;
  // 頁面：先連網路（取得最新版），失敗再用快取，確保離線可開啟
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return res; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  // 其餘（圖示、字體、程式庫、圖片）：先回快取，同時背景更新
  e.respondWith(caches.open(VERSION).then(cache => cache.match(req).then(hit => {
    const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })));
});
