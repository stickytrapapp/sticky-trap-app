// TheStickyTr_ APP — service worker (installable PWA)
// Network-first for the app shell + data so updates always show; cache is only
// an offline fallback. Bump CACHE to force old caches out on activate.
const CACHE = 'st-app-v37';   // promo strip card + configure presets 2026-09-17   // Play QR removed + promo strip = October 2026-09-17;   // Full Speed app-14 2026-09-17; music fence 40% 2026-09-17; Stay Trapping Riff app-11 2026-09-17; Gold on Black at app-7 2026-09-17; music window + tap order 2026-09-17; Stay Trapping dubs x2 2026-09-16; music v3 2026-09-15; black icons 2026-09-10 (icons are cache-first: bump whenever they change)
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
  // Side pages (theme-lab preview, NDA) are never served from this cache: a flaky fetch must not fall back to the main app shell.
  if (url.pathname.startsWith('/lab/') || url.pathname.startsWith('/nda/') || url.pathname.startsWith('/noncompete/') || url.pathname.startsWith('/solitaire/')) return;

  // App shell + data (html/json): NETWORK-FIRST — always try fresh, fall back to cache offline.
  const fresh = req.mode === 'navigate'
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('index.html')
    || url.pathname.endsWith('.json');
  if (fresh) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
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

// ---- Order-update PUSH (2026-09-15, Firebase Cloud Messaging; replaces Twilio texts). The page side is /push.js.
// Chat.gs sends {notification:{title,body}, data:{url,code}} via FCM; the browser hands it here as a push event.
self.addEventListener('push', (e) => {
  let p = {}; try { p = e.data ? e.data.json() : {}; } catch (err) { p = { notification: { title: 'The Sticky Trap', body: e.data ? e.data.text() : '' } }; }
  const n = p.notification || {}, d = p.data || {};
  const title = n.title || d.title || 'The Sticky Trap';
  const opts = { body: n.body || d.body || 'Your order has an update.', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: d.code ? 'order-' + d.code : 'st-order', renotify: true, data: { url: d.url || (n.click_action) || '/track/' } };
  e.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/track/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
