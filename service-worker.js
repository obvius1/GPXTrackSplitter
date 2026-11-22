/* ============================================================
   Service worker voor GPX Track Splitter
   Let op: alle paden zijn relatief. De app draait op GitHub Pages
   onder /GPXTrackSplitter/, waar absolute paden zoals /app.js
   naar de verkeerde plek wijzen.
   ============================================================ */

const CACHE_NAME = 'gpx-splitter-v3';

const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/* Installeren: elk bestand apart, zodat één kapotte URL niet de hele
   cache laat mislukken (cache.addAll is alles-of-niets). */
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);

        await Promise.all(APP_SHELL.map(async url => {
            try {
                const response = await fetch(url, { cache: 'reload' });
                if (response.ok || response.type === 'opaque') await cache.put(url, response);
            } catch (error) {
                console.warn('[sw] niet gecachet:', url, error);
            }
        }));

        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

function isTileRequest(url) {
    return url.hostname.endsWith('tile.openstreetmap.org');
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Kaarttegels regelt de app zelf via IndexedDB; hier niets doen.
    if (isTileRequest(url)) return;

    // Pagina openen: eerst het netwerk (zo zie je updates), anders de cache.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const fresh = await fetch(request);

                // Alleen een echte pagina bewaren. Een hotelportaal antwoordt met
                // 200 en zijn eigen inlogpagina; die mag de offline app niet vervangen.
                const html = (fresh.headers.get('content-type') || '').includes('text/html');
                if (fresh.ok && html && !fresh.redirected) {
                    const cache = await caches.open(CACHE_NAME);
                    cache.put('./index.html', fresh.clone());
                }
                return fresh;
            } catch (error) {
                const cached = await caches.match('./index.html') || await caches.match('./');
                return cached || new Response('Offline en geen opgeslagen versie gevonden.', {
                    status: 503,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            }
        })());
        return;
    }

    // Eigen bestanden en bibliotheken: uit de cache, en op de achtergrond verversen.
    event.respondWith((async () => {
        const cached = await caches.match(request);

        const network = fetch(request).then(response => {
            if (response && (response.ok || response.type === 'opaque')) {
                caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
            }
            return response;
        }).catch(() => null);

        return cached || (await network) || Response.error();
    })());
});
