// SG Bus Tracker — Service Worker (Chrome-safe)
// Strategy:
//   App shell (HTML, CSS, JS, fonts) → Cache-first with background revalidation
//   API calls to the proxy (same-origin :8080 /lta, /ping, /keycheck, etc.)
//                                     → Network-only, bypass SW cache
//   Map tiles (OSM)                   → Cache-first (tiles don't change often)
//   Google Fonts                      → Cache-first
//
// Key fix vs. the old version: we no longer hard-code localhost/127.0.0.1 for
// the proxy check. We detect proxy calls by path prefix on the page origin,
// so it works when the page is served from a LAN IP like 192.168.x.x.

const CACHE_VERSION = 'sg-bus-v10-13';
const TILE_CACHE    = 'sg-bus-tiles-v1';

const APP_SHELL = [
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/state.js',
  '/js/dom.js',
  '/js/toast.js',
  '/js/api.js',
  '/js/stops.js',
  '/js/search.js',
  '/js/arrivals.js',
  '/js/route.js',
  '/js/planner.js',
  '/js/favs.js',
  '/js/pwa.js',
  '/js/cache.js',
  '/js/svc.js',
  '/js/log.js',
  '/js/timing.js',
  '/js/stations.js',
  '/js/train.js',
  '/js/liveLocation.js',
  '/js/alarm.js',
  '/js/mrtHint.js',
  '/data/stations.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600&display=swap',
];

// Paths on the proxy that must never be cached by the SW.
const PROXY_PATHS = ['/lta/', '/ping', '/keycheck', '/setkey', '/cache/'];

function isProxyRequest(url) {
  // Same-origin request whose path starts with any proxy path.
  if (url.origin !== self.location.origin) return false;
  return PROXY_PATHS.some(p => url.pathname.startsWith(p));
}

// ── Install: pre-cache app shell ──────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return Promise.allSettled(
        APP_SHELL.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Could not cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== TILE_CACHE)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ───────────────────────────
self.addEventListener('fetch', event => {
  // Only handle GET. POSTs and others go straight to the network.
  if (event.request.method !== 'GET') return;

  let url;
  try { url = new URL(event.request.url); } catch { return; }

  // 1. API / proxy calls → network-only. Do NOT respondWith(fetch(...))
  //    — letting the request go through untouched keeps the PNA initiator
  //    as the page, which is what we want, and avoids caching.
  if (isProxyRequest(url)) {
    return; // browser handles it, SW does not intercept
  }

  // 2. OSM map tiles → cache-first, long TTL
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached); // offline: tile missing is fine
        })
      )
    );
    return;
  }

  // 3. App shell and CDN assets → cache-first, revalidate in background
  if (
    url.origin === self.location.origin ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(cache =>
        cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached); // offline
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // 4. Everything else → network with cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── Message handler ───────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();

  if (event.data === 'clearTileCache') {
    caches.delete(TILE_CACHE).then(() => {
      event.ports[0]?.postMessage({ ok: true });
    });
  }

  if (event.data === 'getCacheStats') {
    Promise.all([
      caches.open(CACHE_VERSION).then(c => c.keys().then(k => k.length)),
      caches.open(TILE_CACHE).then(c => c.keys().then(k => k.length))
    ]).then(([shell, tiles]) => {
      event.ports[0]?.postMessage({ shell, tiles });
    });
  }
});
