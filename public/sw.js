self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 }))));

// ── Web Push ──
// Payloads are end-to-end encrypted between the server and this worker (the push
// service can't read them), so they carry real event titles.
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Kinboard', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Kinboard';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // `tag` collapses repeats of the same logical notification (e.g. a second
    // digest for the same day replaces the first rather than stacking).
    tag: data.tag || 'kinboard',
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an already-open Kinboard tab if there is one, rather than piling up new
// windows every time a notification is tapped.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if ('focus' in client) {
          if ('navigate' in client && target !== '/') client.navigate(target);
          return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(target) : undefined;
    })
  );
});
