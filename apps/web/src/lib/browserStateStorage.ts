import type { StateStorage } from "zustand/middleware";

const NOOP_STATE_STORAGE: StateStorage = Object.freeze({
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

function isStateStorage(value: unknown): value is StateStorage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function"
  );
}

export function getSafeLocalStorage(): StateStorage {
  if (typeof globalThis === "undefined") {
    return NOOP_STATE_STORAGE;
  }
  return isStateStorage(globalThis.localStorage) ? globalThis.localStorage : NOOP_STATE_STORAGE;
}
