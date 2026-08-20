// TheStickyTr_ APP — service worker (installable PWA)
// Network-first for the app shell + data so updates always show; cache is only
// an offline fallback. Bump CACHE to force old caches out on activate.
const CACHE = 'st-app-v2';
const STATIC = ['./manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // App shell + data (html/json): NETWORK-FIRST — always try fresh, fall back to cache offline.
  const fresh = req.mode === 'navigate'
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('index.html')
    || url.pathname.endsWith('.json');
  if (fresh) {
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Static assets (icons, manifest): cache-first.
  e.respondWith(
    caches.match(req).then((r) => r || fetch(req).then((rp) => {
      const cp = rp.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return rp;
    }))
  );
});
