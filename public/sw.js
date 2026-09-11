const CACHE = 'bp-v2';
const STATIC = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];
const STATIC_PATHS = new Set(STATIC);

// Cache static assets on install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  self.skipWaiting();
});

// Remove old caches on activate
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// API 永遠走網路；靜態內容採 network-first，部署新版時不會卡在舊快取。
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !STATIC_PATHS.has(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then(response => {
        if (response.ok && e.request.method === 'GET') {
          const copy = response.clone();
          e.waitUntil(caches.open(CACHE).then(cache => cache.put(e.request, copy)));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
