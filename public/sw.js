/* EmdadX Attendance — Service Worker (app shell cache + push notifications; never caches the API) */
const CACHE = 'emdadx-att-v6';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/') || url.pathname.includes('/v/')) return;
  // network first, fall back to cache (always fresh when online)
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && (req.mode === 'navigate' || SHELL.some(s => url.pathname.endsWith(s.replace('./', ''))))) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
  );
});

/* ---------- push notifications ---------- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'إشعار جديد', body: e.data ? e.data.text() : '' }; }
  const url = new URL(d.url || './', self.registration.scope).href;
  e.waitUntil(self.registration.showNotification(d.title || 'EmdadX', {
    body: d.body || '', icon: 'icon.svg', badge: 'icon.svg', tag: d.tag || undefined, renotify: !!d.tag,
    dir: 'rtl', lang: 'ar', data: { url }, vibrate: [80, 40, 80],
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); c.postMessage({ type: 'open', url }); return; }
    }
    await clients.openWindow(url);
  })());
});
