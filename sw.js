/* Service worker — site utilisable hors ligne une fois visité.
 * - Fichiers du site (HTML/CSS/JS/icônes) : cache d'abord, mis à jour en arrière-plan.
 * - Données (data/*.json) : réseau d'abord (données fraîches), repli sur la dernière copie en cache.
 * Augmentez VERSION pour forcer la mise à jour du cache du site. */
const VERSION = 'v1';
const CACHE_SITE = 'quinte-site-' + VERSION;
const CACHE_DATA = 'quinte-data';
const FICHIERS = [
  './', './index.html', './manifest.webmanifest', './css/style.css',
  './js/main.js', './js/dataLoader.js', './js/scoreEngine.js', './js/combinaisonGenerator.js',
  './js/backtest.js', './js/charts.js', './js/ui.js', './js/utils.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_SITE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k.startsWith('quinte-site-') && k !== CACHE_SITE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(req)
        .then((rep) => {
          if (rep.ok) { const copie = rep.clone(); caches.open(CACHE_DATA).then((c) => c.put(req, copie)); }
          return rep;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((enCache) => {
      const reseau = fetch(req)
        .then((rep) => {
          if (rep.ok) { const copie = rep.clone(); caches.open(CACHE_SITE).then((c) => c.put(req, copie)); }
          return rep;
        })
        .catch(() => enCache);
      return enCache || reseau;
    })
  );
});
