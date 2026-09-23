const CACHE = 'pi-remote-shell-v3';
const PRECACHE = [];
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(['/', ...PRECACHE]);
    await Promise.allSettled(SHELL.slice(1).map(path => cache.add(path)));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pi-remote-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.origin === self.location.origin &&
      (SHELL.includes(url.pathname) || PRECACHE.includes(url.pathname))) {
    event.respondWith(fetch(event.request).then(async response => {
      if (response.ok) {
        try { await (await caches.open(CACHE)).put(url.pathname, response.clone()); }
        catch { /* The network response is still usable if caching fails. */ }
      }
      return response;
    }).catch(async () => await caches.match(url.pathname) ||
      new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })));
  }
});
// Always show a notification: Safari revokes subscriptions whose pushes show nothing.
self.addEventListener('push', event => {
  let data = null;
  try { data = event.data.json(); } catch { /* Malformed payloads fall back to the generic notice. */ }
  const text = (value, max) => typeof value === 'string' && value ? value.slice(0, max) : null;
  const processId = text(data?.processId, Infinity) ?? undefined;
  event.waitUntil(self.registration.showNotification(text(data?.title, 100) ?? 'Pi Remote Control',
    { body: text(data?.body, 200) ?? 'Session ready', icon: '/icon-192.png', tag: processId, data: { processId } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const processId = event.notification.data?.processId;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (!existing) return self.clients.openWindow(processId ? `/?session=${encodeURIComponent(processId)}` : '/');
    if (processId) existing.postMessage({ type: 'open-session', processId });
    return existing.focus();
  }));
});
