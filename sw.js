/* Build replaces this token with a digest of the entire application shell. */
const REVISION = '__SHELL_REVISION__';
const PREFIX = `wavesync-${encodeURIComponent(self.registration.scope)}-`;
const CACHE = PREFIX + REVISION;
const SHELL = [
  './index.html', './manifest.json', './src/styles.css', './src/app.js',
  './src/config.js', './src/audio-engine.js', './src/sync-engine.js', './src/network.js',
  './src/transfer.js', './src/ui.js', './src/network-quality.js', './src/track-store.js',
  './shared/protocol.js', './assets/icon-192.png', './assets/icon-512.png', './assets/upi-qr.png'
];
const absolute = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  // Failed installation must reject: never destroy a previous usable shell.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.includes('/api/') || url.protocol.startsWith('ws')) return;
  if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async cache =>
      await cache.match(new URL('./index.html', self.registration.scope).href) || fetch(request)));
  } else if (absolute.has(url.href)) {
    // No per-module background refresh: one cache is one coherent application revision.
    event.respondWith(caches.open(CACHE).then(async cache => await cache.match(request) || fetch(request)));
  }
});
