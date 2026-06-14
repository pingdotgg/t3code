import type { ServerPushSendResult, WebPushSubscriptionJson } from "@t3tools/contracts";

import { isElectron } from "../env";
import { ensureLocalApi } from "../localApi";

const SERVICE_WORKER_URL = "/t3-service-worker.js";
const TURN_NOTIFICATION_TAG_PATTERN = /^thread:(.+):turn:[^:]+$/;
export const SYNC_BADGE_MESSAGE_TYPE = "t3.sync-displayed-notification-badge";
export const CLEAR_TURN_COMPLETION_NOTIFICATIONS_MESSAGE_TYPE =
  "t3.clear-turn-completion-notifications";

export interface BrowserPushSupport {
  readonly supported: boolean;
  readonly reason: "supported" | "electron" | "insecure-context" | "missing-browser-api";
}

export interface NotificationTagLike {
  readonly tag?: unknown;
}

export function getBrowserPushSupport(): BrowserPushSupport {
  if (isElectron) {
    return { supported: false, reason: "electron" };
  }
  if (typeof window === "undefined" || !window.isSecureContext) {
    return { supported: false, reason: "insecure-context" };
  }
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return { supported: false, reason: "missing-browser-api" };
  }
  return { supported: true, reason: "supported" };
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined") {
    return "unsupported";
  }
  return "Notification" in window ? Notification.permission : "unsupported";
}

export async function ensureT3ServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const support = getBrowserPushSupport();
  if (!support.supported) {
    throw new Error(pushSupportReasonLabel(support.reason));
  }
  // virtual:pwa-register cannot pass registration options and may re-register
  // this URL without updateViaCache. The cache-busted import and server
  // Cache-Control headers are the primary fix; this only helps transition
  // already-stale installs.
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { updateViaCache: "none" });
}

/**
 * Closes any displayed OS notifications for a thread when it is viewed in-app,
 * so stale notifications cannot re-inflate the app icon badge on the next push.
 *
 * Best-effort: never registers the service worker (uses getRegistration) and
 * swallows errors. Notification tags are server-issued as `thread:{threadId}:…`
 * using the raw thread id, so callers must pass the raw id (not the scoped key)
 * and we match by prefix because getNotifications({tag}) is exact-match only.
 */
export async function closeThreadNotifications(threadId: string): Promise<void> {
  if (!getBrowserPushSupport().supported || threadId.length === 0) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration || typeof registration.getNotifications !== "function") {
      return;
    }
    const prefix = `thread:${threadId}:`;
    const notifications = await registration.getNotifications();
    for (const notification of notifications) {
      if (notification.tag.startsWith(prefix)) {
        notification.close();
      }
    }
  } catch {
    // Closing notifications is best-effort and must never disrupt navigation.
  }
}

export function countTurnCompletionNotificationThreads(
  notifications: readonly NotificationTagLike[],
): number {
  const threadIds = new Set<string>();
  for (const notification of notifications) {
    const tag = typeof notification.tag === "string" ? notification.tag : "";
    const match = TURN_NOTIFICATION_TAG_PATTERN.exec(tag);
    if (match) {
      threadIds.add(match[1]!);
    }
  }
  return threadIds.size;
}

export async function getDisplayedTurnCompletionThreadCount(): Promise<number | null> {
  if (!getBrowserPushSupport().supported) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration || typeof registration.getNotifications !== "function") {
      return null;
    }
    const notifications = await registration.getNotifications();
    return countTurnCompletionNotificationThreads(notifications);
  } catch {
    return null;
  }
}

export async function closeTurnCompletionNotifications(
  registration?: ServiceWorkerRegistration | null,
): Promise<number | null> {
  if (!getBrowserPushSupport().supported) {
    return null;
  }
  try {
    const resolvedRegistration = registration ?? (await navigator.serviceWorker.getRegistration());
    if (!resolvedRegistration || typeof resolvedRegistration.getNotifications !== "function") {
      return null;
    }
    const notifications = await resolvedRegistration.getNotifications();
    let closedCount = 0;
    for (const notification of notifications) {
      const tag = typeof notification.tag === "string" ? notification.tag : "";
      if (TURN_NOTIFICATION_TAG_PATTERN.test(tag) && typeof notification.close === "function") {
        notification.close();
        closedCount += 1;
      }
    }
    return closedCount;
  } catch {
    return null;
  }
}

function postServiceWorkerMessage(registration: ServiceWorkerRegistration, type: string): boolean {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker || typeof worker.postMessage !== "function") {
    return false;
  }
  // ServiceWorker.postMessage does not accept a target origin.
  // oxlint-disable-next-line require-post-message-target-origin
  worker.postMessage({ type });
  return true;
}

export async function requestServiceWorkerBadgeSync(
  registration?: ServiceWorkerRegistration | null,
): Promise<boolean> {
  if (isElectron || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }
  try {
    const resolvedRegistration = registration ?? (await navigator.serviceWorker.getRegistration());
    if (!resolvedRegistration) {
      return false;
    }
    return postServiceWorkerMessage(resolvedRegistration, SYNC_BADGE_MESSAGE_TYPE);
  } catch {
    return false;
  }
}

export async function requestServiceWorkerTurnCompletionNotificationClear(
  registration?: ServiceWorkerRegistration | null,
): Promise<boolean> {
  if (isElectron || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }
  try {
    const resolvedRegistration = registration ?? (await navigator.serviceWorker.getRegistration());
    if (!resolvedRegistration) {
      return false;
    }
    return postServiceWorkerMessage(
      resolvedRegistration,
      CLEAR_TURN_COMPLETION_NOTIFICATIONS_MESSAGE_TYPE,
    );
  } catch {
    return false;
  }
}

export async function clearTurnCompletionAlerts(
  registration?: ServiceWorkerRegistration | null,
): Promise<void> {
  await Promise.allSettled([
    closeTurnCompletionNotifications(registration),
    requestServiceWorkerTurnCompletionNotificationClear(registration),
  ]);
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const registration = await ensureT3ServiceWorkerRegistration();
  return registration.pushManager.getSubscription();
}

export async function enablePushNotifications(): Promise<WebPushSubscriptionJson> {
  const registration = await ensureT3ServiceWorkerRegistration();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const config = await ensureLocalApi().server.getPushConfig();
  if (!config.supported || !config.publicVapidKey) {
    throw new Error("Push notifications are not available on this server.");
  }

  const existingSubscription = await registration.pushManager.getSubscription();
  if (existingSubscription) {
    await existingSubscription.unsubscribe();
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicVapidKey),
  });
  const subscriptionJson = toWebPushSubscriptionJson(subscription);
  await ensureLocalApi().server.registerPushSubscription({
    subscription: subscriptionJson,
    userAgent: navigator.userAgent,
  });
  return subscriptionJson;
}

export async function disablePushNotifications(): Promise<void> {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) {
    return;
  }
  const endpoint = subscription.endpoint;
  await Promise.allSettled([
    ensureLocalApi().server.unregisterPushSubscription({ endpoint }),
    subscription.unsubscribe(),
  ]);
}

export async function sendTestPushNotification(): Promise<ServerPushSendResult> {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) {
    throw new Error("Push notifications are not enabled in this browser.");
  }
  const result = await ensureLocalApi().server.sendTestPushNotification({
    endpoint: subscription.endpoint,
  });
  if (result.sentCount === 0) {
    throw new Error(
      result.lastFailureDetail
        ? `Push provider rejected the test notification: ${result.lastFailureDetail}`
        : "Push provider rejected the test notification.",
    );
  }
  return result;
}

export function pushSupportReasonLabel(reason: BrowserPushSupport["reason"]): string {
  switch (reason) {
    case "supported":
      return "Push notifications are available.";
    case "electron":
      return "Browser push notifications are only available in the web app.";
    case "insecure-context":
      return "Push notifications require HTTPS or localhost.";
    case "missing-browser-api":
      return "This browser does not support web push notifications.";
  }
}

function toWebPushSubscriptionJson(subscription: PushSubscription): WebPushSubscriptionJson {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("Browser returned an incomplete push subscription.");
  }
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  };
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}
