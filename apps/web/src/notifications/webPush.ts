import { ManagedRelay, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type {
  RelayWebPushPreferences,
  RelayWebPushRegistrationRequest,
  RelayWebPushSubscription,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

import { readManagedRelayClerkToken } from "~/cloud/managedAuth";
import { runtime } from "~/lib/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const WEB_PUSH_SERVICE_WORKER_PATH = "/web-push-service-worker.js";
const WEB_PUSH_SERVICE_WORKER_SCOPE = "/";

export function isWebPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

function decodeBase64Url(value: string): ArrayBuffer {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0)).buffer;
}

function encodeBase64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return encodeBase64Url(digest);
}

function webPushPreferences(settings: ClientSettings): RelayWebPushPreferences {
  return {
    notifyOnApproval: settings.desktopNotifyApprovalNeeded,
    notifyOnCompletion: settings.desktopNotifyTaskCompleted,
    notifyOnFailure: settings.desktopNotifyTaskFailed,
    soundEnabled: settings.desktopNotificationSound,
  };
}

function serializeSubscription(subscription: PushSubscription): RelayWebPushSubscription {
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (p256dh === null || auth === null) {
    throw new Error("The browser returned a Web Push subscription without encryption keys.");
  }
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: {
      p256dh: encodeBase64Url(p256dh),
      auth: encodeBase64Url(auth),
    },
  };
}

async function relayToken(): Promise<string> {
  const token = await readManagedRelayClerkToken();
  if (!token) {
    throw new Error("Sign in to T3 Connect before enabling Web Push.");
  }
  return token;
}

async function registerSubscription(
  subscription: PushSubscription,
  settings: ClientSettings,
): Promise<void> {
  const payload: RelayWebPushRegistrationRequest = {
    subscriptionId: await subscriptionId(subscription.endpoint),
    label: navigator.platform ? `Web browser on ${navigator.platform}` : "Web browser",
    subscription: serializeSubscription(subscription),
    preferences: webPushPreferences(settings),
  };
  const clerkToken = await relayToken();
  await runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap((client) => client.registerWebPush({ clerkToken, payload })),
    ),
  );
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(WEB_PUSH_SERVICE_WORKER_PATH, {
    scope: WEB_PUSH_SERVICE_WORKER_SCOPE,
  });
  return navigator.serviceWorker.ready;
}

async function ensureSubscription(
  registration: ServiceWorkerRegistration,
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    return existing;
  }
  const { publicKey } = await runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap((client) => client.getWebPushVapidPublicKey),
    ),
  );
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(publicKey),
  });
}

export async function enableWebPushNotifications(settings: ClientSettings): Promise<void> {
  if (!isWebPushSupported()) {
    throw new Error("This browser does not support Web Push.");
  }
  await relayToken();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const registration = await serviceWorkerRegistration();
  const subscription = await ensureSubscription(registration);
  try {
    await registerSubscription(subscription, settings);
  } catch (error) {
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function disableWebPushNotifications(): Promise<void> {
  if (!isWebPushSupported()) {
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration(WEB_PUSH_SERVICE_WORKER_SCOPE);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) {
    return;
  }
  try {
    const clerkToken = await readManagedRelayClerkToken();
    if (clerkToken) {
      const id = await subscriptionId(subscription.endpoint);
      await runtime.runPromise(
        ManagedRelay.ManagedRelayClient.pipe(
          Effect.flatMap((client) => client.unregisterWebPush({ clerkToken, subscriptionId: id })),
        ),
      );
    }
  } finally {
    await subscription.unsubscribe();
  }
}

export async function reconcileWebPushRegistration(settings: ClientSettings): Promise<void> {
  if (!isWebPushSupported()) {
    return;
  }
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (!session || !settings.webPushNotificationsEnabled) {
    await disableWebPushNotifications();
    return;
  }
  if (Notification.permission !== "granted") {
    return;
  }
  const registration = await serviceWorkerRegistration();
  const subscription = await ensureSubscription(registration);
  await registerSubscription(subscription, settings);
}
