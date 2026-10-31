// Service worker: offline app shell, web push display, notification clicks.
const VERSION = 'ff-v1';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/ui.js', '/js/store.js', '/js/time.js', '/js/editors.js', '/js/views.js', '/js/more.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cal/')) return; // always live
  if (e.request.mode === 'navigate') {
    // network first so updates arrive; cached shell when offline
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put('/index.html', copy)); return r; })
      .catch(() => caches.match('/index.html')));
    return;
  }
  // static files: serve cache, refresh in background
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Family Flow', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'Family Flow', {
      body: data.body || '', tag: data.tag, renotify: !!data.tag, icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', data: { url: data.url || '/' },
    });
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'push' });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); if ('navigate' in w) await w.navigate(target).catch(() => {}); return; } }
    await self.clients.openWindow(target);
  })());
});
