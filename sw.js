/* Service worker — Planning Eloi
 * Stratégie : "réseau d'abord" (network-first) pour les ressources locales.
 * En ligne -> toujours la dernière version ; hors-ligne -> repli sur le cache.
 * Évite les versions figées en cache après un déploiement.
 */
const CACHE = 'eloitimer-v10';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-32.png',
  './icons/icon-16.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Réseau d'abord : on tente le réseau, on met à jour le cache, et on ne
  // retombe sur le cache qu'en cas d'échec (hors-ligne).
  event.respondWith(
    fetch(request)
      .then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(request))
  );
});
