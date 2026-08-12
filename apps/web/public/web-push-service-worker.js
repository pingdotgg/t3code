const PAYLOAD_VERSION = 1;

function notificationPayload(value) {
  if (typeof value !== "object" || value === null || value.version !== PAYLOAD_VERSION) {
    return null;
  }
  const required = ["title", "body", "path", "tag", "updatedAt"];
  if (required.some((key) => typeof value[key] !== "string")) {
    return null;
  }
  if (typeof value.silent !== "boolean" || !value.path.startsWith("/")) {
    return null;
  }
  return value;
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data;
      try {
        data = event.data?.json();
      } catch {
        return;
      }
      const payload = notificationPayload(data);
      if (!payload) {
        return;
      }

      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watchingThread = windows.some((client) => {
        const url = new URL(client.url);
        return client.focused && url.pathname === payload.path;
      });
      if (watchingThread) {
        return;
      }

      const timestamp = Date.parse(payload.updatedAt);
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: "/apple-touch-icon.png",
        badge: "/favicon-32x32.png",
        data: { path: payload.path },
        tag: payload.tag,
        renotify: true,
        silent: payload.silent,
        ...(Number.isNaN(timestamp) ? {} : { timestamp }),
        ...(payload.silent ? {} : { vibrate: [120, 60, 180] }),
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.path;
  if (typeof path !== "string" || !path.startsWith("/")) {
    return;
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows[0];
      if (existing) {
        await existing.navigate(path);
        await existing.focus();
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});
