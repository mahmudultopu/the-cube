/* Offline support: caches the game on first visit so it runs without internet.
   Bump VERSION whenever any cached file changes so phones pick up the update. */
const VERSION = 'cube-v1';
const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/style.css',
  'assets/js/game.js',
  'assets/vendor/three.min.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Pages: try the network first so updates arrive, fall back to the cached game offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./', copy)); return res; })
        .catch(() => caches.match('./'))
    );
    return;
  }

  // Everything else (game files, Google Fonts): serve from cache, fetch and store on a miss.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
