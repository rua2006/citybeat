// ─── CITYBEAT SERVICE WORKER ──────────────────────────────────────────────────
// Strategy:
//   • App shell (HTML/CSS/JS) → Cache First, update in background
//   • Map tiles          → Cache First (big win for offline maps)
//   • Google Fonts       → Cache First with long TTL
//   • API calls          → Network First, fallback to cache
//   • Everything else    → Network First

const VERSION      = 'citybeat-v1';
const SHELL_CACHE  = `${VERSION}-shell`;
const TILES_CACHE  = `${VERSION}-tiles`;
const FONTS_CACHE  = `${VERSION}-fonts`;
const API_CACHE    = `${VERSION}-api`;

// Files to pre-cache on install (the app shell)
// Base path — set to '/citybeat/' for GitHub Pages, '/' for custom domain
const BASE = self.registration.scope;

const SHELL_URLS = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.json',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'icons/apple-touch-icon.png',
];

// External resources we want cached
const FONT_ORIGINS  = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const TILE_ORIGINS  = ['basemaps.cartocdn.com'];
const LEAFLET_CDNS  = ['cdnjs.cloudflare.com'];

// ── INSTALL ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing', VERSION);
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()) // activate immediately
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating', VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('citybeat-') && k !== SHELL_CACHE && k !== TILES_CACHE && k !== FONTS_CACHE && k !== API_CACHE)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and chrome-extension requests
  if(event.request.method !== 'GET') return;
  if(url.protocol === 'chrome-extension:') return;

  // Map tiles → Cache First (tiles rarely change, offline maps are huge UX win)
  if(TILE_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(cacheFirst(event.request, TILES_CACHE, { maxAge: 7 * 24 * 60 * 60 }));
    return;
  }

  // Google Fonts → Cache First
  if(FONT_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(cacheFirst(event.request, FONTS_CACHE, { maxAge: 30 * 24 * 60 * 60 }));
    return;
  }

  // Leaflet CDN → Cache First
  if(LEAFLET_CDNS.some(o => url.hostname.includes(o))) {
    event.respondWith(cacheFirst(event.request, SHELL_CACHE, { maxAge: 7 * 24 * 60 * 60 }));
    return;
  }

  // App shell → Stale While Revalidate
  if(url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event.request, SHELL_CACHE));
    return;
  }

  // Everything else → Network First, fall back to cache
  event.respondWith(networkFirst(event.request, API_CACHE));
});

// ── CACHE STRATEGIES ─────────────────────────────────────────────────────────

// Cache First: serve from cache, only fetch if not cached
async function cacheFirst(request, cacheName, options={}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if(cached) return cached;
  try {
    const response = await fetch(request);
    if(response.ok) cache.put(request, response.clone());
    return response;
  } catch(e) {
    return offlineFallback(request);
  }
}

// Stale While Revalidate: serve cache instantly, update cache in background
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then(response => {
      if(response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

// Network First: try network, fall back to cache
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if(response.ok) cache.put(request, response.clone());
    return response;
  } catch(e) {
    const cached = await cache.match(request);
    return cached || offlineFallback(request);
  }
}

// Offline fallback for HTML requests
function offlineFallback(request) {
  if(request.headers.get('accept')?.includes('text/html')) {
    return caches.match('/') || new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>CITYBEAT — Offline</title>
      <style>body{background:#0e0e0f;color:#e8e6e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;}
      h1{color:#f0a500;font-size:2em;letter-spacing:3px;} p{color:#7a7870;font-size:14px;}</style></head>
      <body><h1>CITYBEAT</h1><p>You're offline. Connect to browse live events.</p></body></html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
  return new Response('Offline', { status: 503 });
}

// ── PUSH NOTIFICATIONS (stub — ready to wire up) ──────────────────────────────
self.addEventListener('push', event => {
  if(!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'CITYBEAT', {
      body: data.body || 'New events added in your cities.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'citybeat-update',
      data: { url: data.url || '/' },
      actions: [
        { action: 'view', title: 'View Events' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if(event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for(const client of clientList) {
        if(client.url === '/' && 'focus' in client) return client.focus();
      }
      if(clients.openWindow) return clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
