// Offline-Fähigkeit: App-Dateien zwischenspeichern, bei Netz immer die aktuelle Version laden.
const CACHE = "laermprotokoll-v2";
const DATEIEN = ["./", "index.html", "style.css", "app.js", "analyse.js", "lauscher.js", "speicher.js",
  "worklet.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png",
  "icon-maskable-512.png"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (ev) => {
  if (ev.request.method !== "GET") return;
  ev.respondWith(
    fetch(ev.request)
      .then((r) => { const kopie = r.clone(); caches.open(CACHE).then((c) => c.put(ev.request, kopie)); return r; })
      .catch(() => caches.match(ev.request, { ignoreSearch: true })),
  );
});
