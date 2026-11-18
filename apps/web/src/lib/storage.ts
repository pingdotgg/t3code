import { Debouncer } from "@tanstack/react-pacer";
import * as Equal from "effect/Equal";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DeferredStorage<TValue> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: TValue) => void;
  removeItem: (name: string) => void;
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  return isStateStorage(storage) ? storage : createMemoryStorage();
}

export function createDeferredStorage<TValue>(
  baseStorage: Partial<StateStorage> | null | undefined,
  serialize: (value: TValue) => string,
  debounceMs: number = 300,
): DeferredStorage<TValue> {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: TValue) => {
      resolvedStorage.setItem(name, serialize(value));
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      // cancel() leaves the captured value in Pacer's lastArgs.
      debouncedSetItem.reset();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}

/** Applies the entries `local` changed since `baseline` (deletes included) over `stored`. */
export function mergeRecordChanges<V>(
  stored: Readonly<Record<string, V>> | undefined,
  local: Readonly<Record<string, V>>,
  baseline: Readonly<Record<string, V>>,
): Record<string, V> {
  const merged = { ...stored };
  for (const key of new Set([...Object.keys(local), ...Object.keys(baseline)])) {
    if (Equal.equals(local[key], baseline[key])) continue;
    const value = local[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}
