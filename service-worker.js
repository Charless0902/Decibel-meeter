/*
 * Loud Enough service worker.
 * Caches the whole app on first visit so it opens offline. Files are served
 * from the cache instantly and refreshed in the background, so a new deploy
 * shows up on the next launch. Bump VERSION if you add or rename files.
 */
const VERSION = 'v1';
const CACHE = 'loud-enough-' + VERSION;
const ASSETS = [
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icons/favicon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const SCOPE = self.registration.scope; // e.g. https://you.github.io/Decibel-meeter/
const INDEX = new URL('./index.html', SCOPE).href;
const ASSET_URLS = new Set(ASSETS.map((path) => new URL(path, SCOPE).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((path) => new Request(new URL(path, SCOPE), { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('loud-enough-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  url.search = '';
  url.hash = '';
  let key = url.href;
  if (key === SCOPE) key = INDEX; // "/" and "/index.html" are the same page
  if (key !== INDEX && !ASSET_URLS.has(key)) return; // not part of the app: browser default
  event.respondWith(serve(key, event));
});

function serve(key, event) {
  return caches.open(CACHE).then((cache) =>
    cache.match(key).then((cached) => {
      const fresh = fetch(key, { cache: 'no-cache' }).then((res) => {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      });
      if (cached) {
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh.catch(() => Response.error());
    })
  );
}
