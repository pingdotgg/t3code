import { selectSidebarThreadsAcrossEnvironments, useStore, type AppState } from "../store";
import { countUnseenCompletedThreads } from "../threadCompletion";
import { useUiStateStore, type UiState } from "../uiStateStore";

export interface AppBadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

let badgeSyncInstalled = false;
let syncScheduled = false;
let lastRequestedBadgeCount: number | null = null;
let appStoreUnsubscribe: (() => void) | null = null;
let uiStateStoreUnsubscribe: (() => void) | null = null;

function readBadgeNavigator(): AppBadgeNavigator | null {
  return typeof navigator === "undefined" ? null : (navigator as AppBadgeNavigator);
}

export function canUseAppBadge(navigatorLike: AppBadgeNavigator | null = readBadgeNavigator()) {
  return typeof navigatorLike?.setAppBadge === "function";
}

export function selectCompletedConversationBadgeCount(
  appState: AppState,
  uiState: Pick<UiState, "threadLastVisitedAtById">,
): number {
  return countUnseenCompletedThreads(
    selectSidebarThreadsAcrossEnvironments(appState),
    uiState.threadLastVisitedAtById,
  );
}

export async function writeAppBadgeCount(
  count: number,
  navigatorLike: AppBadgeNavigator | null = readBadgeNavigator(),
): Promise<boolean> {
  if (!canUseAppBadge(navigatorLike) || !navigatorLike?.setAppBadge) {
    return false;
  }

  const badgeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

  try {
    if (badgeCount > 0) {
      await navigatorLike.setAppBadge(badgeCount);
      return true;
    }

    if (typeof navigatorLike.clearAppBadge === "function") {
      await navigatorLike.clearAppBadge();
      return true;
    }

    await navigatorLike.setAppBadge(0);
    return true;
  } catch {
    return false;
  }
}

function syncAppBadge(): void {
  syncScheduled = false;
  const badgeCount = selectCompletedConversationBadgeCount(
    useStore.getState(),
    useUiStateStore.getState(),
  );

  if (badgeCount === lastRequestedBadgeCount) {
    return;
  }

  lastRequestedBadgeCount = badgeCount;
  void writeAppBadgeCount(badgeCount).then((updated) => {
    if (!updated && lastRequestedBadgeCount === badgeCount) {
      lastRequestedBadgeCount = null;
    }
  });
}

function scheduleAppBadgeSync(): void {
  if (syncScheduled) {
    return;
  }
  syncScheduled = true;
  queueMicrotask(syncAppBadge);
}

export function resyncAppBadge(): void {
  lastRequestedBadgeCount = null;
  scheduleAppBadgeSync();
}

function handleWindowFocus(): void {
  resyncAppBadge();
}

function handleDocumentVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    resyncAppBadge();
  }
}

export function installPwaAppBadgeSync(): void {
  if (badgeSyncInstalled || !canUseAppBadge()) {
    return;
  }

  badgeSyncInstalled = true;
  appStoreUnsubscribe = useStore.subscribe(scheduleAppBadgeSync);
  uiStateStoreUnsubscribe = useUiStateStore.subscribe(scheduleAppBadgeSync);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", handleWindowFocus);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
  }
  scheduleAppBadgeSync();
}

export function __resetPwaAppBadgeSyncForTests(): void {
  appStoreUnsubscribe?.();
  uiStateStoreUnsubscribe?.();
  appStoreUnsubscribe = null;
  uiStateStoreUnsubscribe = null;
  if (typeof window !== "undefined") {
    window.removeEventListener("focus", handleWindowFocus);
  }
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
  }
  badgeSyncInstalled = false;
  syncScheduled = false;
  lastRequestedBadgeCount = null;
}
