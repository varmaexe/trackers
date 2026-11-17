// Service worker: offline app shell + push notifications.
const CACHE = "trackers-v5";
const SHELL = ["/", "/app.css", "/app.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show up right away), cache when offline. API calls are never cached.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const key = e.request.mode === "navigate" ? "/" : url.pathname;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(e.request);
        if (res.ok && res.type === "basic") cache.put(key, res.clone());
        return res;
      } catch {
        return (await cache.match(key)) || Response.error();
      }
    })()
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(
    self.registration.showNotification(d.title || "Trackers", {
      body: d.body || "",
      tag: d.tag,
      renotify: !!d.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: d.data || {},
      actions: d.actions || [],
    })
  );
});

async function tellClients(msg) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  all.forEach((c) => c.postMessage(msg));
  return all;
}

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const data = n.data || {};
  n.close();

  if (e.action === "done" && data.tracker_id) {
    e.waitUntil(
      (async () => {
        try {
          const res = await fetch("/api/entries", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json", "x-requested-with": "tracker" },
            body: JSON.stringify({ id: crypto.randomUUID(), tracker_id: data.tracker_id, date: data.date, value: 1 }),
          });
          if (!res.ok) throw new Error(res.status);
          await tellClients({ type: "refresh" });
        } catch {
          await self.registration.showNotification("Couldn't log it", { body: "Open the app to log it.", data, tag: n.tag });
        }
      })()
    );
    return;
  }

  e.waitUntil(
    (async () => {
      const all = await tellClients({ type: "open", tracker_id: data.tracker_id });
      const win = all.find((c) => "focus" in c);
      if (win) return win.focus();
      return self.clients.openWindow("/" + (data.tracker_id ? "?t=" + encodeURIComponent(data.tracker_id) : ""));
    })()
  );
});
