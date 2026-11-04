import { createContext, use, useSyncExternalStore } from "react";

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
