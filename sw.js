/* NS Painel — service worker */
const VERSION = '2.6.0';
const CACHE = 'ns-painel-v' + VERSION;
const CORE = ['./', 'index.html', 'app.js', 'parser.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // remove caches de versões anteriores (inclusive o motor de OCR da v1, ~11 MB)
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // rede primeiro (app e data.txt sempre atualizados); sem rede, usa a última cópia
  e.respondWith(fetch(e.request, url.pathname.endsWith('/data.txt') ? { cache: 'no-store' } : undefined).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
