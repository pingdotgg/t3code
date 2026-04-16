import { useSyncExternalStore } from "react";

/**
 * Creates a lightweight external store backed by `useSyncExternalStore`.
 * Use for ephemeral cross-component state that doesn't belong in route
 * params (e.g. large text, complex objects).
 */
export function createExternalStore<T>(initialValue: T) {
  let current: T = initialValue;
  const listeners = new Set<() => void>();

  function emitChange() {
    listeners.forEach((listener) => listener());
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): T {
    return current;
  }

  function set(value: T) {
    current = value;
    emitChange();
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  return { set, getSnapshot, subscribe, useValue } as const;
}
