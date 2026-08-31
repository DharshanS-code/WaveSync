/* WaveSync Service Worker — offline app shell + fast startup */
const CACHE = 'wavesync-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './src/styles.css',
  './src/app.js',
  './src/config.js',
  './src/audio-engine.js',
  './src/sync-engine.js',
  './src/network.js',
  './src/ui.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/upi-qr.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Never cache signaling / websockets / cross-origin API calls.
  if (req.method !== 'GET' || url.protocol.startsWith('ws') || url.pathname.includes('/api/')) {
    return;
  }

  // App-shell: cache-first with network refresh (stale-while-revalidate).
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
