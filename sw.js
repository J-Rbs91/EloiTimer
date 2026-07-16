/* Service worker — Planning Eloi
 * Stratégie « offline-first » adaptée à une appli utilitaire qui doit
 * s'ouvrir instantanément :
 *   - navigation    : cache-first sur index.html, avec repli réseau puis
 *                     mise à jour du cache en arrière-plan ;
 *   - fichiers      : stale-while-revalidate (on sert le cache tout de suite,
 *     statiques       on rafraîchit en arrière-plan) ;
 *   - hors ligne    : tout fonctionne sur le cache déjà présent.
 *
 * L'activation ne prend PAS le contrôle de force : la nouvelle version reste
 * en attente (« waiting ») jusqu'à ce que la page demande explicitement à
 * l'activer (message SKIP_WAITING) — aucune saisie en cours n'est interrompue.
 */
const CACHE = 'eloitimer-v27';
const CORE = './index.html';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './sync-core.js',
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
  // On précache dans un cache DÉDIÉ puis on bascule seulement si tout a réussi :
  // une installation partiellement échouée ne casse pas l'ancienne version.
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .catch((e) => { console.warn('Précache partiel :', e); })
    // Pas de skipWaiting() ici : on attend le feu vert de la page.
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// La page peut demander l'activation immédiate d'une version en attente.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // laisse passer l'externe (rien de bloquant)

  // Navigations : cache-first sur la coquille de l'app, repli réseau.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(CORE).then((cached) => {
        const network = fetch(request)
          .then((resp) => {
            if (resp && resp.status === 200) {
              const copy = resp.clone();
              caches.open(CACHE).then((c) => c.put(CORE, copy));
            }
            return resp;
          })
          .catch(() => cached);
        // Si la coquille est en cache : affichage immédiat, MAJ en arrière-plan.
        return cached || network;
      })
    );
    return;
  }

  // Fichiers statiques : stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
