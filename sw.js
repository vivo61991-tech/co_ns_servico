/* NS Leitor — service worker */
const VERSION = '1.0.0';
const CACHE = 'ns-leitor-v' + VERSION;
const VENDOR_CACHE = 'ns-leitor-vendor-5.1.1'; // motor de OCR (só muda se trocar a versão do Tesseract)
const CORE = ['./', 'index.html', 'app.js', 'engine.js', 'ocr-adapter.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'vendor/tesseract.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/') && !url.pathname.endsWith('tesseract.min.js')) {
    // arquivos grandes do OCR: cache-first, guardados no 1º uso
    e.respondWith(caches.open(VENDOR_CACHE).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // app: rede primeiro (pega atualização), cai pro cache offline
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
