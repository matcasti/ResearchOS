// ResearchOS — Service Worker
// Hace que la app arranque sin conexión después de la primera visita.
//  · Archivos propios: red primero (siempre ves tu última versión); si no hay red, copia en caché.
//  · Librerías de CDN (versiones fijadas en la URL): caché primero.
//  · Todo lo demás (Google Drive, CrossRef…) pasa sin tocar.
const SHELL_CACHE = 'researchos-shell-v1';
const CDN_CACHE   = 'researchos-cdn-v1';
const SHELL = ['./', 'index.html', 'style.css', 'db.js', 'app.js', 'researchos-tutorial.json'];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => ![SHELL_CACHE, CDN_CACHE].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request, { cache: 'no-cache' });     // revalida: nunca sirve un app.js viejo del caché HTTP
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

// La página (que ya descargó las librerías en la primera visita) nos pasa sus URLs de CDN para guardarlas
// de inmediato: así la app arranca sin conexión desde la 2.ª visita sin esperar a una recarga controlada por el SW.
self.addEventListener('message', event => {
  if (event.data?.type !== 'cache-cdn') return;
  const urls = (event.data.urls || []).filter(u => { try { return CDN_HOSTS.includes(new URL(u).hostname); } catch { return false; } });
  event.waitUntil(caches.open(CDN_CACHE).then(cache => Promise.all(urls.map(async u => {
    if (await cache.match(u)) return;
    try { const res = await fetch(u, { mode: 'cors', credentials: 'omit' }); if (res.ok) await cache.put(u, res); } catch {}
  }))));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
});
