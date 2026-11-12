import { useSyncExternalStore } from "react";

/**
 * Whether the launch splash still waits for Home's list. The list holds the splash while it
 * has cached rows to lay out, so the first frame after the splash shows them.
 */
let homeRows: "none" | "pending" | "settled" = "none";
const listeners = new Set<() => void>();

function setHomeRows(next: typeof homeRows) {
  // Settled is final: lists that mount after the launch must not hold anything.
  if (homeRows === next || homeRows === "settled") return;
  homeRows = next;
  for (const listener of listeners) listener();
}

/** Home's list has rows that are not laid out yet. */
export function holdLaunchSplashForHomeRows(): void {
  setHomeRows("pending");
}

/** The rows are laid out, the launch opened another route, or the splash is gone. */
export function settleLaunchSplashHomeRows(): void {
  setHomeRows("settled");
}

export function launchSplashHomeRowsPending(): boolean {
  return homeRows === "pending";
}

function subscribeHomeRows(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useLaunchSplashHomeRowsPending(): boolean {
  return useSyncExternalStore(subscribeHomeRows, launchSplashHomeRowsPending);
}

/**
 * Whether the native splash can hide: after the cached shells are read and Home's list has
 * laid out their rows. One limit ends both waits.
 */
export function splashCanHide(input: {
  readonly preferencesReady: boolean;
  readonly shellCachesRead: boolean;
  readonly homeRowsPending: boolean;
  readonly waitEnded: boolean;
}): boolean {
  if (!input.preferencesReady) return false;
  return input.waitEnded || (input.shellCachesRead && !input.homeRowsPending);
}
