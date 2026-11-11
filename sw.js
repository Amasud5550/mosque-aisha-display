/* Offline cache for the prayer screen (service worker).
 *
 * Keeps a copy of the screen, its fonts and the slide images so the TV still
 * starts up and keeps showing times if the internet drops (prayer data itself
 * is cached by the page). The admin page and the data files are never cached.
 *
 * Bump VERSION if this file's caching rules change.
 */
const VERSION = "v2";
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;
const MAX_ASSETS = 80;
const PRECACHE = ["./", "./index.html", "./screen.js", "./fonts/fonts.css", "./assets/logo.png"];

// Always straight to the network: admin, data, and anything the admin preview loads
const BYPASS = /\/(admin\.html|admin\.js|config\.json|prayerTimes\.json|sw\.js)$/;
const ASSET_HOSTS = new Set(["raw.githubusercontent.com"]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (BYPASS.test(url.pathname) || url.searchParams.get("preview") === "1") return;
    // fonts and the logo never change: serve the saved copy straight away
    if (/\/(fonts|assets)\//.test(url.pathname)) { event.respondWith(staleWhileRevalidate(req)); return; }
    event.respondWith(networkFirst(req, url));
    return;
  }

  if (ASSET_HOSTS.has(url.hostname) && !url.pathname.endsWith(".json")) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

// The screen itself: always try for the newest version, fall back to the saved copy
async function networkFirst(req, url) {
  const cache = await caches.open(SHELL);
  const key = url.origin + url.pathname; // ?location=… and ?t=… share one copy
  try {
    const res = await fetchWithTimeout(req, 6000);
    if (res.ok && res.type === "basic") await cache.put(key, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(key)) || (url.pathname.endsWith("/") ? await cache.match(key + "index.html") : null);
    if (hit) return hit;
    throw e;
  }
}

// Fonts and slide images: show the saved copy instantly, refresh it in the background
async function staleWhileRevalidate(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  const update = fetch(req)
    .then(async (res) => {
      if (res.ok || res.type === "opaque") {
        await cache.put(req, res.clone());
        trim(cache);
      }
      return res;
    })
    .catch(() => null);
  return hit || (await update) || Response.error();
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
}

function fetchWithTimeout(req, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}
