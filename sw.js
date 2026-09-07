// VirtuKey Forma service worker.
// Strategies: app shell precache, network-first navigations and API reads (last-known data offline),
// stale-while-revalidate static assets, cache-first web fonts. Mutations always go to the network.
const VERSION = "forma-2026-09-07";
const STATIC_CACHE = `${VERSION}:static`;
const RUNTIME_CACHE = `${VERSION}:runtime`;
const FONT_CACHE = `${VERSION}:fonts`;
const RETAINED = new Set([STATIC_CACHE, RUNTIME_CACHE, FONT_CACHE]);
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/styles.css?v=26",
  "/app.js?v=26",
  "/manifest.webmanifest",
  "/VKT-logo.png",
  "/icons/apple-touch-icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => !RETAINED.has(name)).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

const cacheable = (response) => response && (response.ok || response.type === "opaque");

async function networkFirst(request, cacheName, fallbackUrl = null) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (cacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (cause) {
    const cached = await cache.match(request) || await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw cause;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((response) => {
    if (cacheable(response)) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || refresh;
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.open(cacheName).then((cache) => cache.match(request));
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept writes
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    if (url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com") {
      event.respondWith(cacheFirst(request, FONT_CACHE));
    }
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, STATIC_CACHE, "/index.html"));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});
