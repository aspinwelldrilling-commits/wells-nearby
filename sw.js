/* Wells Nearby service worker: lets the app open with no signal (so a site can still be tagged: GPS works offline).
 * Same-origin files: network first (always fresh when online), cached copy when offline. Cross-origin requests
 * (map tiles, state/county data, parcel lookup) are not touched. */
const CACHE = 'wells-nearby-shell-v11';
const SHELL = ['./', 'index.html', 'css/app.css', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'js/config.js', 'js/data.js', 'js/stats.js', 'js/match.js', 'js/docs.js', 'js/countywcr.js', 'js/app.js', 'js/sites.js', 'js/parcels.js', 'js/search.js', 'js/septic-core.js', 'js/septic.js',
  'data/county-wcr/manifest.json', 'data/riverside-wcr/manifest.json'];
SHELL.push('js/imperial.js', 'data/imperial-wcr/manifest.json');   // Imperial County DWR WCR overlay
SHELL.push('js/lawcr.js', 'data/la-wcr/manifest.json');   // Los Angeles County DWR WCR overlay
SHELL.push('js/myjobs.js');   // My Jobs (private Google Earth import, stored on the device only)
SHELL.push('js/layout-core.js', 'js/layout.js');   // ✏️ Septic layout drawing + plot plan (stored on the device only)
// County WCR tiles (data/county-wcr/tiles/*.json?v=hash) are cached as they are fetched; offline, any cached version is used.
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  // cache: 'no-cache' revalidates with the server, so a phone never mixes a fresh page with a 10-min-old HTTP-cached app.js
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
