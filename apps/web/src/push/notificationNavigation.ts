import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { reconcileAfterNotificationClick } from "../environments/runtime/service";
import { recordResumeDiagnostic } from "../environments/runtime/resumeDiagnostics";
import type { AppRouter } from "../router";
import type { DraftId } from "../composerDraftStore";

export const NOTIFICATION_CLICK_MESSAGE_TYPE = "t3.notification-click";

let lastNotificationNavigationTarget: NotificationNavigationTarget | null = null;

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
}

export function installServiceWorkerNotificationNavigation(router: AppRouter): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => undefined;
  }

  const serviceWorker = navigator.serviceWorker;
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
    const target = parseNotificationNavigationTarget(event.data.url);
    if (target === null) {
      recordResumeDiagnostic("notification-navigation-target", {
        reason: "parse-failed",
        data: {
          url: event.data.url,
        },
      });
      return;
    }

    lastNotificationNavigationTarget = target;
    recordResumeDiagnostic("notification-navigation-target", {
      reason: "parsed",
      ...(target.kind === "thread" ? { env: target.environmentId } : {}),
      data: { target },
    });
    const openedAt =
      event.data.openedAt !== undefined && Number.isFinite(event.data.openedAt)
        ? event.data.openedAt
        : undefined;
    reconcileAfterNotificationClick(target, openedAt === undefined ? undefined : { openedAt });
    void navigateToNotificationTarget(router, target);
  };

  serviceWorker.addEventListener("message", handleMessage);
  return () => {
    serviceWorker.removeEventListener("message", handleMessage);
  };
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
