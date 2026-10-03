import { createContext, use, useSyncExternalStore } from "react";

/**
 * Swipe actions (the live swipe gesture and the hidden action buttons) only
 * exist around the viewport. Every other Home row is dormant: the same row
 * tree without them, so a row the list rebuilds while scrolling is cheaper and
 * waking it never remounts its content. The scroll gate already disables
 * swipes while the list moves, so rows are activated once it rests.
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
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    isActive: (key: string) => activeKeys.has(key),
    activate(keys: ReadonlyArray<string>) {
      if (listTouches.size > 0) pendingKeys = keys;
      else apply(keys);
    },
    /**
     * `started` are touches that just began on the list; `onScreen` is every
     * finger still down anywhere. A finger on another control never holds
     * changes, and one whose end event went missing is dropped here.
     */
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

/** Rows outside an activation provider (e.g. the iPad sidebar) stay live. */
export function useSwipeRowDormant(key: string | undefined): boolean {
  const activation = use(SwipeRowActivationContext);
  return useSyncExternalStore(
    activation?.subscribe ?? subscribeNever,
    () => activation !== null && key !== undefined && !activation.isActive(key),
  );
}
