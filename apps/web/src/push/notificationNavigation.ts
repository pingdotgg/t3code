import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { reconcileAfterNotificationClick } from "../environments/runtime/service";
import { recordResumeDiagnostic } from "../environments/runtime/resumeDiagnostics";
import type { AppRouter } from "../router";
import type { DraftId } from "../composerDraftStore";
import {
  clearPendingNotificationClick,
  readPendingNotificationClick,
} from "./pendingNotificationClick";

export const NOTIFICATION_CLICK_MESSAGE_TYPE = "t3.notification-click";
// Mirrored in public/t3-push-service-worker.js. The service worker is a plain
// public asset, so it cannot import this TypeScript helper directly.
export const NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME = "t3-notification-click";

let lastNotificationNavigationTarget: NotificationNavigationTarget | null = null;
let lastHandledClick: { readonly url: string; readonly openedAt: number } | null = null;

const PENDING_NOTIFICATION_CLICK_TTL_MS = 2 * 60 * 1000;
const PENDING_NOTIFICATION_CLICK_RETRY_DELAYS_MS = [250, 500, 1000] as const;

interface NotificationClickClientMessage {
  readonly type: typeof NOTIFICATION_CLICK_MESSAGE_TYPE;
  readonly url: string;
  readonly openedAt?: number;
}

export type NotificationNavigationTarget =
  | { readonly kind: "home" }
  | {
      readonly kind: "thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | { readonly kind: "draft"; readonly draftId: DraftId }
  | { readonly kind: "pair" }
  | { readonly kind: "settings"; readonly to: SettingsRouteTo };

type SettingsRouteTo =
  | "/settings"
  | "/settings/archived"
  | "/settings/connections"
  | "/settings/diagnostics"
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control";

const SETTINGS_ROUTES = new Set<string>([
  "/settings",
  "/settings/archived",
  "/settings/connections",
  "/settings/diagnostics",
  "/settings/general",
  "/settings/keybindings",
  "/settings/providers",
  "/settings/source-control",
]);

export function isNotificationClickClientMessage(
  data: unknown,
): data is NotificationClickClientMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === NOTIFICATION_CLICK_MESSAGE_TYPE &&
    "url" in data &&
    typeof data.url === "string"
  );
}

export function resolveNotificationUrl(rawUrl: string, baseOrigin: string): URL | null {
  try {
    const url = new URL(rawUrl, baseOrigin);
    return url.origin === baseOrigin ? url : null;
  } catch {
    return null;
  }
}

export function parseNotificationNavigationTarget(
  rawUrl: string,
  baseOrigin = window.location.origin,
): NotificationNavigationTarget | null {
  const url = resolveNotificationUrl(rawUrl, baseOrigin);
  if (url === null) {
    return null;
  }

  const pathname = normalizePathname(url.pathname);
  if (pathname === "/") {
    return { kind: "home" };
  }

  if (pathname === "/pair") {
    return { kind: "pair" };
  }

  if (SETTINGS_ROUTES.has(pathname)) {
    return {
      kind: "settings",
      to: pathname as SettingsRouteTo,
    };
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "draft" && segments.length === 2) {
    const draftId = decodePathSegment(segments[1] ?? "");
    if (draftId === null) {
      return null;
    }
    return {
      kind: "draft",
      draftId: draftId as DraftId,
    };
  }

  if (segments[0] === "draft" || segments[0] === "pair" || segments[0] === "settings") {
    return null;
  }

  if (segments.length === 2) {
    const environmentId = decodePathSegment(segments[0] ?? "");
    const threadId = decodePathSegment(segments[1] ?? "");
    if (environmentId === null || threadId === null) {
      return null;
    }
    return {
      kind: "thread",
      environmentId: environmentId as EnvironmentId,
      threadId: threadId as ThreadId,
    };
  }

  return null;
}

export function getLastNotificationNavigationTarget(): NotificationNavigationTarget | null {
  return lastNotificationNavigationTarget;
}

export function resetNotificationNavigationStateForTests(): void {
  lastNotificationNavigationTarget = null;
  lastHandledClick = null;
}

export function installServiceWorkerNotificationNavigation(router: AppRouter): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => undefined;
  }

  const serviceWorker = navigator.serviceWorker;
  const cleanupCallbacks: Array<() => void> = [];
  const replayAbortController = new AbortController();
  let replayInFlight: Promise<void> | null = null;
  const replayPendingClick = (reason: string) => {
    if (replayAbortController.signal.aborted || replayInFlight !== null) {
      return;
    }

    const replay = consumePendingNotificationClick(router, reason, {
      retryDelaysMs: hasPendingNotificationClickCache()
        ? PENDING_NOTIFICATION_CLICK_RETRY_DELAYS_MS
        : [],
      signal: replayAbortController.signal,
    });
    const replayWithCleanup = replay.finally(() => {
      if (replayInFlight === replayWithCleanup) {
        replayInFlight = null;
      }
    });
    replayInFlight = replayWithCleanup;
    void replayWithCleanup;
  };
  const handleMessage = (event: MessageEvent<unknown>) => {
    if (!isNotificationClickClientMessage(event.data)) {
      return;
    }

    recordResumeDiagnostic("notification-navigation-message", {
      reason: "service-worker-message",
      data: {
        url: event.data.url,
        openedAt: event.data.openedAt,
      },
    });
    void handleNotificationClickNavigation(router, {
      clearPending: true,
      reason: "service-worker-message",
      url: event.data.url,
      ...(event.data.openedAt !== undefined ? { openedAt: event.data.openedAt } : {}),
    });
  };

  serviceWorker.addEventListener("message", handleMessage);
  if ("startMessages" in serviceWorker) {
    const startMessages = serviceWorker.startMessages;
    if (typeof startMessages === "function") {
      startMessages.call(serviceWorker);
    }
  }
  cleanupCallbacks.push(() => {
    serviceWorker.removeEventListener("message", handleMessage);
  });

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME);
      const handleBroadcastMessage = (event: MessageEvent<unknown>) => {
        if (!isNotificationClickClientMessage(event.data)) {
          return;
        }

        if (
          typeof document !== "undefined" &&
          typeof document.hasFocus === "function" &&
          !document.hasFocus()
        ) {
          recordResumeDiagnostic("notification-navigation-message", {
            reason: "broadcast-ignored-unfocused",
            data: {
              url: event.data.url,
              openedAt: event.data.openedAt,
            },
          });
          return;
        }

        recordResumeDiagnostic("notification-navigation-message", {
          reason: "broadcast-channel",
          data: {
            url: event.data.url,
            openedAt: event.data.openedAt,
          },
        });
        void handleNotificationClickNavigation(router, {
          clearPending: true,
          reason: "broadcast-channel",
          url: event.data.url,
          ...(event.data.openedAt !== undefined ? { openedAt: event.data.openedAt } : {}),
        });
      };

      channel.addEventListener("message", handleBroadcastMessage);
      cleanupCallbacks.push(() => {
        channel.removeEventListener("message", handleBroadcastMessage);
        channel.close();
      });
    } catch {
      // Broadcast delivery is best-effort. Service worker postMessage and the
      // pending-click cache still cover browsers that do not support it here.
    }
  }

  if (typeof window !== "undefined" && "addEventListener" in window) {
    const handleFocus = () => replayPendingClick("window-focus");
    const handlePageShow = () => replayPendingClick("pageshow");
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    cleanupCallbacks.push(() => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
    });
  }

  if (typeof document !== "undefined" && "addEventListener" in document) {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        replayPendingClick("visibilitychange-visible");
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    cleanupCallbacks.push(() => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    });
  }

  replayPendingClick("startup");

  return () => {
    replayAbortController.abort();
    replayInFlight = null;
    for (const cleanup of cleanupCallbacks) {
      cleanup();
    }
  };
}

export async function consumePendingNotificationClick(
  router: AppRouter,
  reason = "manual",
  options: {
    readonly retryDelaysMs?: ReadonlyArray<number>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  const pending = await readPendingNotificationClickWithRetry(
    options.retryDelaysMs ?? [],
    options.signal,
  );
  if (pending === null || isAbortSignalAborted(options.signal)) {
    return;
  }

  const pendingAgeMs = Date.now() - pending.openedAt;
  if (pendingAgeMs > PENDING_NOTIFICATION_CLICK_TTL_MS) {
    recordResumeDiagnostic("notification-navigation-pending", {
      reason: "stale",
      data: {
        replayReason: reason,
        url: pending.url,
        openedAt: pending.openedAt,
        ageMs: pendingAgeMs,
        ttlMs: PENDING_NOTIFICATION_CLICK_TTL_MS,
      },
    });
    await clearPendingNotificationClick();
    return;
  }

  const handled = handleNotificationClickNavigation(router, {
    clearPending: false,
    openedAt: pending.openedAt,
    reason,
    url: pending.url,
  });
  if (!handled) {
    recordResumeDiagnostic("notification-navigation-pending", {
      reason: "ignored",
      data: {
        replayReason: reason,
        url: pending.url,
        openedAt: pending.openedAt,
      },
    });
  }
  await clearPendingNotificationClick();
}

async function readPendingNotificationClickWithRetry(
  retryDelaysMs: ReadonlyArray<number>,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof readPendingNotificationClick>>> {
  if (isAbortSignalAborted(signal)) {
    return null;
  }

  const pending = await readPendingNotificationClick();
  if (isAbortSignalAborted(signal)) {
    return null;
  }
  if (pending !== null) {
    return pending;
  }

  for (const delayMs of retryDelaysMs) {
    await sleep(delayMs, signal);
    if (isAbortSignalAborted(signal)) {
      return null;
    }
    const retryPending = await readPendingNotificationClick();
    if (isAbortSignalAborted(signal)) {
      return null;
    }
    if (retryPending !== null) {
      return retryPending;
    }
  }

  return null;
}

function hasPendingNotificationClickCache(): boolean {
  return typeof window !== "undefined" && "caches" in window;
}

function isAbortSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (isAbortSignalAborted(signal)) {
    return;
  }

  await new Promise<void>((resolve) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function handleNotificationClickNavigation(
  router: AppRouter,
  input: {
    readonly clearPending: boolean;
    readonly openedAt?: number;
    readonly reason: string;
    readonly url: string;
  },
): boolean {
  const openedAt = Number.isFinite(input.openedAt) ? input.openedAt : undefined;
  if (
    openedAt !== undefined &&
    lastHandledClick?.url === input.url &&
    lastHandledClick.openedAt === openedAt
  ) {
    recordResumeDiagnostic("notification-navigation-message", {
      reason: "duplicate",
      data: {
        source: input.reason,
        url: input.url,
        openedAt,
      },
    });
    if (input.clearPending) {
      void clearPendingNotificationClick();
    }
    return true;
  }

  const target = parseNotificationNavigationTarget(input.url);
  if (target === null) {
    recordResumeDiagnostic("notification-navigation-target", {
      reason: "parse-failed",
      data: {
        source: input.reason,
        url: input.url,
      },
    });
    if (input.clearPending) {
      void clearPendingNotificationClick();
    }
    return false;
  }

  lastNotificationNavigationTarget = target;
  recordResumeDiagnostic("notification-navigation-target", {
    reason: "parsed",
    ...(target.kind === "thread" ? { env: target.environmentId } : {}),
    data: {
      source: input.reason,
      target,
    },
  });
  if (openedAt !== undefined) {
    lastHandledClick = {
      url: input.url,
      openedAt,
    };
  }
  reconcileAfterNotificationClick(target, openedAt === undefined ? undefined : { openedAt });
  void navigateToNotificationTarget(router, target);
  if (input.clearPending) {
    void clearPendingNotificationClick();
  }
  return true;
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function decodePathSegment(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function navigateToNotificationTarget(
  router: AppRouter,
  target: NotificationNavigationTarget,
): Promise<void> {
  switch (target.kind) {
    case "home":
      await router.navigate({ to: "/" });
      return;
    case "thread":
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: target.environmentId,
          threadId: target.threadId,
        },
        search: {},
      });
      return;
    case "draft":
      await router.navigate({
        to: "/draft/$draftId",
        params: { draftId: target.draftId },
      });
      return;
    case "pair":
      await router.navigate({ to: "/pair" });
      return;
    case "settings":
      await router.navigate({ to: target.to });
      return;
  }
}
