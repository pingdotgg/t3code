const DEFAULT_NOTIFICATION_TITLE = "Salchi";
const DEFAULT_NOTIFICATION_URL = "/";
const NOTIFICATION_CLICK_MESSAGE_TYPE = "t3.notification-click";
// Mirrored in src/push/notificationNavigation.ts. The service worker is a
// public plain JS asset, so it cannot import the TypeScript helper directly.
const NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME = "t3-notification-click";
const NOTIFICATION_TITLE_SOURCE_SUFFIX = /(?:^|\s+)from\s+Salchi\s*$/i;
// Mirrored in src/push/pendingNotificationClick.ts. The service worker is a
// public plain JS asset, so it cannot import the TypeScript helper directly.
const PENDING_NOTIFICATION_CLICK_CACHE_NAME = "t3-notification-click-v1";
const PENDING_NOTIFICATION_CLICK_REQUEST_PATH = "/__t3-notification-click/pending";

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  const title = notificationTitle(payload.title);
  const notification = {
    body: payload.body || undefined,
    icon: "/salchi-pwa-192.png",
    badge: "/salchi-pwa-192.png",
    tag: payload.tag || "t3code",
    data: {
      url: payload.url || DEFAULT_NOTIFICATION_URL,
    },
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, notification);
      await syncDisplayedNotificationBadge({ skipVisibleClient: true });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = resolveNotificationUrl(event.notification.data?.url);

  event.waitUntil(
    (async () => {
      await syncDisplayedNotificationBadge();
      await openNotificationUrl(url);
    })(),
  );
});

function readPushPayload(event) {
  if (!event.data) {
    return {};
  }

  try {
    return event.data.json();
  } catch {
    return {};
  }
}

function notificationTitle(rawTitle) {
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  const strippedTitle = title.replace(NOTIFICATION_TITLE_SOURCE_SUFFIX, "").trim();
  return strippedTitle || DEFAULT_NOTIFICATION_TITLE;
}

function resolveNotificationUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || DEFAULT_NOTIFICATION_URL, self.location.origin);
    return url.origin === self.location.origin
      ? url.href
      : new URL(DEFAULT_NOTIFICATION_URL, self.location.origin).href;
  } catch {
    return new URL(DEFAULT_NOTIFICATION_URL, self.location.origin).href;
  }
}

function normalizePathname(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function clientMatchesNotificationUrl(clientUrl, notificationUrl) {
  try {
    const client = new URL(clientUrl);
    const target = new URL(notificationUrl);
    return (
      client.origin === target.origin &&
      normalizePathname(client.pathname) === normalizePathname(target.pathname) &&
      client.search === target.search &&
      client.hash === target.hash
    );
  } catch {
    return false;
  }
}

async function openNotificationUrl(url) {
  const click = {
    url,
    openedAt: Date.now(),
  };
  await persistPendingNotificationClick(click);
  broadcastNotificationClick(click);

  return openNotificationClickTarget(click);
}

async function openNotificationClickTarget(click) {
  const [clients, controlledClients] = await Promise.all([
    self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    }),
    self.clients.matchAll({
      type: "window",
    }),
  ]);
  const sameOriginClients = clients.filter((client) => isSameOriginUrl(client.url));
  if (sameOriginClients.length === 0) {
    return openWindowAndPostNotificationClick(click);
  }

  const targetClient = selectNotificationClient(sameOriginClients, click.url);
  if (isControlledNotificationClient(targetClient, controlledClients)) {
    return focusClientAndPostNotificationClick(targetClient, click);
  }

  return navigateFocusAndPostNotificationClick(targetClient, click);
}

function canSetAppBadge() {
  return typeof self.navigator?.setAppBadge === "function";
}

function isVisibleSameOriginClient(client) {
  return (
    isSameOriginUrl(client.url) && (client.focused === true || client.visibilityState === "visible")
  );
}

async function hasVisibleSameOriginWindowClient() {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return clients.some((client) => isVisibleSameOriginClient(client));
}

async function syncDisplayedNotificationBadge(options = {}) {
  if (!canSetAppBadge() || typeof self.registration?.getNotifications !== "function") {
    return false;
  }

  if (options.skipVisibleClient === true && (await hasVisibleSameOriginWindowClient())) {
    return false;
  }

  const notifications = await self.registration.getNotifications();
  return writeServiceWorkerAppBadge(notifications.length);
}

async function writeServiceWorkerAppBadge(count) {
  const badgeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  try {
    if (badgeCount > 0) {
      await self.navigator.setAppBadge(badgeCount);
      return true;
    }

    if (typeof self.navigator.clearAppBadge === "function") {
      await self.navigator.clearAppBadge();
      return true;
    }

    await self.navigator.setAppBadge(0);
    return true;
  } catch {
    return false;
  }
}

async function navigateFocusAndPostNotificationClick(client, click) {
  if (!client) {
    return openWindowAndPostNotificationClick(click);
  }

  if (clientMatchesNotificationUrl(client.url, click.url)) {
    return focusClientAndPostNotificationClick(client, click);
  }

  const navigatedClient = await navigateNotificationClient(client, click.url);
  if (navigatedClient) {
    return focusClientAndPostNotificationClick(navigatedClient, click);
  }

  const focusedClient = await focusClientAndPostNotificationClick(client, click);
  return focusedClient || openWindowAndPostNotificationClick(click);
}

async function navigateNotificationClient(client, url) {
  if (!client || !("navigate" in client)) {
    return null;
  }

  try {
    return await client.navigate(url);
  } catch {
    return null;
  }
}

async function focusClientAndPostNotificationClick(client, click) {
  if ("focus" in client) {
    let focusedClient = client;
    try {
      focusedClient = (await client.focus()) || client;
    } catch {
      focusedClient = client;
    }
    postNotificationClickMessage(focusedClient, click);
    return focusedClient;
  }

  postNotificationClickMessage(client, click);
  return undefined;
}

async function openWindowAndPostNotificationClick(click) {
  const client = await openNotificationWindow(click.url);
  postNotificationClickMessage(client, click);
  return client;
}

async function openNotificationWindow(url) {
  try {
    return await self.clients.openWindow(url);
  } catch {
    return null;
  }
}

function postNotificationClickMessage(client, click) {
  if (!client || !("postMessage" in client)) {
    return;
  }

  const message = {
    type: NOTIFICATION_CLICK_MESSAGE_TYPE,
    url: click.url,
    openedAt: click.openedAt,
  };

  // Client.postMessage from a service worker does not accept a target origin.
  // oxlint-disable-next-line require-post-message-target-origin
  client.postMessage(message);
}

function broadcastNotificationClick(click) {
  if (!("BroadcastChannel" in self)) {
    return;
  }

  let channel = null;
  try {
    channel = new self.BroadcastChannel(NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME);
    const message = {
      type: NOTIFICATION_CLICK_MESSAGE_TYPE,
      url: click.url,
      openedAt: click.openedAt,
    };
    // BroadcastChannel.postMessage does not accept a target origin.
    // oxlint-disable-next-line require-post-message-target-origin
    channel.postMessage(message);
  } catch {
    // Broadcast delivery is best-effort. The pending-click cache remains the
    // fallback for clients that miss this message.
  } finally {
    try {
      channel?.close();
    } catch {
      // Closing a best-effort channel must not block notification handling.
    }
  }
}

async function persistPendingNotificationClick(click) {
  if (!("caches" in self)) {
    return;
  }

  try {
    const cache = await self.caches.open(PENDING_NOTIFICATION_CLICK_CACHE_NAME);
    await cache.put(
      makePendingNotificationClickRequest(),
      new Response(JSON.stringify(click), {
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );
  } catch {
    // This persistence is best-effort. Direct navigation/postMessage still runs.
  }
}

function makePendingNotificationClickRequest() {
  return new Request(new URL(PENDING_NOTIFICATION_CLICK_REQUEST_PATH, self.location.origin), {
    method: "GET",
  });
}

function isControlledNotificationClient(client, controlledClients) {
  if (!client || !("id" in client) || typeof client.id !== "string") {
    return false;
  }

  return controlledClients.some((controlledClient) => controlledClient.id === client.id);
}

function selectNotificationClient(sameOriginClients, url) {
  return (
    sameOriginClients.find((client) => clientMatchesNotificationUrl(client.url, url)) ||
    sameOriginClients.find((client) => client.focused) ||
    sameOriginClients.find((client) => client.visibilityState === "visible") ||
    sameOriginClients[0] ||
    null
  );
}

function isSameOriginUrl(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}
