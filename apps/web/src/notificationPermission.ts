import { useCallback, useSyncExternalStore } from "react";

export type NotificationPermissionState = "unsupported" | NotificationPermission;

export function readNotificationPermission(): NotificationPermissionState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function showNotification(input: {
  title: string;
  body: string;
  tag: string;
  onClick?: () => void;
}): boolean {
  if (readNotificationPermission() !== "granted") return false;

  try {
    const shown = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      icon: "/apple-touch-icon.png",
    });
    shown.addEventListener(
      "click",
      () => {
        window.focus();
        shown.close();
        input.onClick?.();
      },
      { once: true },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Permission is process-wide, so it is held in one store rather than per hook
 * instance: granting it from Settings has to reach the watcher mounted in the
 * app shell, and it is also changed outside the page, in browser site
 * settings, where returning to the tab is the only notice of it.
 */
const listeners = new Set<() => void>();
let permissionSnapshot = readNotificationPermission();

function syncPermission(): NotificationPermissionState {
  const next = readNotificationPermission();
  if (next !== permissionSnapshot) {
    permissionSnapshot = next;
    for (const listener of listeners) listener();
  }
  return permissionSnapshot;
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("focus", syncPermission);
    document.addEventListener("visibilitychange", syncPermission);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("focus", syncPermission);
      document.removeEventListener("visibilitychange", syncPermission);
    }
  };
}

function getPermissionSnapshot(): NotificationPermissionState {
  return permissionSnapshot;
}

export function useNotificationPermission(): {
  readonly permission: NotificationPermissionState;
  readonly request: () => Promise<NotificationPermissionState>;
} {
  const permission = useSyncExternalStore(subscribe, getPermissionSnapshot, getPermissionSnapshot);

  // Must be called from a user gesture: browsers reject a prompt raised outside
  // one, and Safari does so without resolving the promise.
  const request = useCallback(async () => {
    if (typeof Notification === "undefined") return "unsupported" as const;
    if (Notification.permission === "default") {
      await Notification.requestPermission().catch(() => Notification.permission);
    }
    return syncPermission();
  }, []);

  return { permission, request };
}
