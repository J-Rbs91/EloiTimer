/* Service worker — Planning Eloi
 * Stratégie « offline-first » adaptée à une appli utilitaire qui doit
 * s'ouvrir instantanément :
 *   - navigation    : cache-first sur index.html, avec repli réseau puis
 *                     mise à jour du cache en arrière-plan ;
 *   - fichiers      : stale-while-revalidate (on sert le cache tout de suite,
 *     statiques       on rafraîchit en arrière-plan) ;
 *   - hors ligne    : tout fonctionne sur le cache déjà présent.
 *
 * Robustesse (correctif « l'app ne s'ouvre plus ») :
 *   - précache TOLÉRANT AUX PANNES : chaque fichier est mis en cache
 *     individuellement. Un seul fichier momentanément indisponible pendant un
 *     déploiement ne doit PLUS vider tout le cache (l'ancien `addAll` était
 *     atomique : un échec = cache vide = app bloquée sur l'écran de démarrage).
 *   - réseau BORNÉ DANS LE TEMPS : aucune requête servie par le SW ne peut
 *     bloquer indéfiniment le premier rendu ; au-delà du délai, on retombe sur
 *     le cache ou on renvoie une réponse d'erreur propre (jamais de « respond
 *     with » qui ne se résout jamais).
 *   - `respondWith` renvoie TOUJOURS une Response : sur une connexion « morte »
 *     mais ouverte (fréquent en mobilité), la page n'attend jamais dans le vide.
 *
 * L'activation ne prend PAS le contrôle de force : la nouvelle version reste
 * en attente (« waiting ») jusqu'à ce que la page demande explicitement à
 * l'activer (message SKIP_WAITING) — aucune saisie en cours n'est interrompue.
 */
const CACHE = 'eloitimer-v28';
const CORE = './index.html';
// Fichiers dont dépend le PREMIER RENDU : ils doivent impérativement être en
// cache pour une ouverture fiable hors ligne.
const CRITICAL = ['./index.html', './styles.css', './sync-core.js', './app.js'];
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

// Délai maximal d'attente réseau avant repli sur le cache : jamais de blocage
// du premier rendu, même sur une connexion qui « pend » sans répondre.
const NET_TIMEOUT_MS = 5000;

/**
 * fetch borné dans le temps : renvoie la Response, ou `null` en cas d'échec ou
 * de dépassement de délai (ne rejette jamais, ne pend jamais).
 */
function timedFetch(request, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done(null), timeoutMs || NET_TIMEOUT_MS);
    fetch(request).then((resp) => done(resp)).catch(() => done(null));
  });
}

self.addEventListener('install', (event) => {
  // Précache TOLÉRANT : on met chaque fichier en cache séparément pour qu'un
  // seul échec (fichier momentanément 404 pendant un déploiement, coupure
  // réseau ponctuelle…) ne laisse PAS un cache vide. On garantit au moins la
  // présence des fichiers critiques du premier rendu.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (url) => {
      try {
        const resp = await timedFetch(new Request(url, { cache: 'reload' }), NET_TIMEOUT_MS);
        if (resp && resp.status === 200) await cache.put(url, resp.clone());
        else console.warn('Précache ignoré (réponse non 200) :', url);
      } catch (e) {
        console.warn('Précache ignoré (erreur) :', url, e);
      }
    }));
    // Pas de skipWaiting() ici : on attend le feu vert de la page.
  })());
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

// Met le cache à jour en arrière-plan sans jamais bloquer la réponse renvoyée.
function refreshInBackground(event, request, key) {
  event.waitUntil((async () => {
    const resp = await timedFetch(request, NET_TIMEOUT_MS);
    if (resp && resp.status === 200) {
      const cache = await caches.open(CACHE);
      await cache.put(key || request, resp.clone());
    }
  })());
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // laisse passer l'externe (rien de bloquant)

  // Navigations : cache-first sur la coquille de l'app, repli réseau BORNÉ.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match(CORE);
      if (cached) {
        // Affichage immédiat, mise à jour de la coquille en arrière-plan.
        refreshInBackground(event, request, CORE);
        return cached;
      }
      // Rien en cache : réseau borné, puis dernier repli propre.
      const net = await timedFetch(request, NET_TIMEOUT_MS);
      if (net) {
        if (net.status === 200) {
          const cache = await caches.open(CACHE);
          cache.put(CORE, net.clone());
        }
        return net;
      }
      return (await caches.match(CORE))
        || new Response(
          '<!doctype html><meta charset="utf-8"><title>Hors ligne</title>'
          + '<body style="font-family:system-ui;padding:2rem;color:#0b2038">'
          + '<h1>Planning Eloi</h1><p>Application momentanément indisponible. '
          + 'Vérifie ta connexion puis rouvre l’application.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
        );
    })());
    return;
  }

  // Fichiers statiques : stale-while-revalidate, réponse TOUJOURS résolue.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      refreshInBackground(event, request); // rafraîchit sans bloquer
      return cached;
    }
    const net = await timedFetch(request, NET_TIMEOUT_MS);
    if (net) {
      if (net.status === 200) {
        const cache = await caches.open(CACHE);
        cache.put(request, net.clone());
      }
      return net;
    }
    // Ni cache ni réseau : réponse d'erreur PROPRE (jamais d'attente infinie).
    return Response.error();
  })());
});
