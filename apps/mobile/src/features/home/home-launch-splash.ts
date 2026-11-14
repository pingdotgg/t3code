import { useSyncExternalStore } from "react";

/**
 * Whether the launch splash still waits for Home's list. A list holds the splash while it
 * has cached rows to lay out, so the first frame after the splash shows them.
 */
export function createLaunchSplashHomeRows() {
  let holds = 0;
  let settled = false;
  const listeners = new Set<() => void>();
  const pending = () => !settled && holds > 0;
  const change = (apply: () => void) => {
    const before = pending();
    apply();
    if (pending() !== before) for (const listener of listeners) listener();
  };
  return {
    pending,
    /**
     * A Home list has rows that are not laid out yet. Call the returned release when it no
     * longer has them or unmounts; rows that come later can hold again.
     */
    hold: () => {
      let held = true;
      change(() => {
        holds += 1;
      });
      return () => {
        if (!held) return;
        held = false;
        change(() => {
          holds -= 1;
        });
      };
    },
    /**
     * The rows are laid out, the launch opened another route, or the splash is gone. It is
     * final: lists that mount after the launch must not hold anything.
     */
    settle: () =>
      change(() => {
        settled = true;
      }),
    subscribe: (onChange: () => void) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

const homeRows = createLaunchSplashHomeRows();

export const holdLaunchSplashForHomeRows = homeRows.hold;
export const settleLaunchSplashHomeRows = homeRows.settle;
export const launchSplashHomeRowsPending = homeRows.pending;

export function useLaunchSplashHomeRowsPending(): boolean {
  return useSyncExternalStore(homeRows.subscribe, homeRows.pending);
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
