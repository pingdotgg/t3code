import { createContext, use, useSyncExternalStore } from "react";

// Rows this far past the viewport stay awake, and the window moves once the viewport comes within
// FOLLOW_MARGIN of its edge, so a finger catching a fling lands on a row whose swipe is already on.
const ACTIVE_MARGIN = 6;
const FOLLOW_MARGIN = 3;

type KeyedRows = ReadonlyArray<{ readonly key: string }>;

/**
 * Only rows around the viewport enable swipe gestures and render actions.
 * Dormant rows keep the same child views so waking them preserves touches.
 */
export function createSwipeRowActivation() {
  let activeKeys = new Set<string>();
  // Turning a row's swipe gesture off ends a swipe in progress, so changes
  // wait until every finger that started on the list has lifted.
  const listTouches = new Set<string>();
  let pendingKeys: ReadonlyArray<string> | null = null;
  const listeners = new Set<() => void>();
  const apply = (keys: ReadonlyArray<string>) => {
    if (keys.length === activeKeys.size && keys.every((key) => activeKeys.has(key))) return;
    activeKeys = new Set(keys);
    for (const listener of listeners) listener();
  };
  const activate = (keys: ReadonlyArray<string>) => {
    if (listTouches.size > 0) pendingKeys = keys;
    else apply(keys);
  };
  const activateAround = (rows: KeyedRows, start: number, end: number) =>
    activate(
      rows.slice(Math.max(0, start - ACTIVE_MARGIN), end + ACTIVE_MARGIN + 1).map((row) => row.key),
    );
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    isActive: (key: string) => activeKeys.has(key),
    activate,
    activateAround,
    /** Called on every scroll event; renders only when the viewport nears the window's edge. */
    followScroll(rows: KeyedRows, start: number, end: number) {
      for (
        let index = Math.max(0, start - FOLLOW_MARGIN);
        index <= end + FOLLOW_MARGIN;
        index += 1
      ) {
        const row = rows[index];
        if (row !== undefined && !activeKeys.has(row.key)) return activateAround(rows, start, end);
      }
    },
    trackTouches(started: ReadonlyArray<string>, onScreen: ReadonlyArray<string>) {
      for (const id of started) listTouches.add(id);
      for (const id of listTouches) if (!onScreen.includes(id)) listTouches.delete(id);
      if (listTouches.size > 0 || pendingKeys === null) return;
      const keys = pendingKeys;
      pendingKeys = null;
      apply(keys);
    },
  };
}

export type SwipeRowActivation = ReturnType<typeof createSwipeRowActivation>;

export const SwipeRowActivationContext = createContext<SwipeRowActivation | null>(null);

const subscribeNever = () => () => {};

export function useSwipeRowDormant(key: string | undefined): boolean {
  const activation = use(SwipeRowActivationContext);
  return useSyncExternalStore(
    activation?.subscribe ?? subscribeNever,
    () => activation !== null && key !== undefined && !activation.isActive(key),
  );
}
