/*
 * Academia service worker — deliberately online-only.
 *
 * Nothing but the offline page is cached. Every request goes to the network; when a page
 * navigation fails (no connection), the offline page is shown instead. This keeps the app
 * installable without ever serving stale code or data.
 */
const CACHE = "academia-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // everything else: straight to the network
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(event.request);
      } catch (error) {
        const cache = await caches.open(CACHE);
        const offline = await cache.match(OFFLINE_URL);
        return offline || new Response("You are offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })(),
  );
});
