import type { StoreApi, UseBoundStore } from "zustand";

type PersistedStore = UseBoundStore<StoreApi<unknown>> & {
  persist: { rehydrate: () => void | Promise<void> };
};

/**
 * Under the Qt shell the right panel's content renders in a second document
 * (the embed route) that shares localStorage with the primary one. zustand's
 * persist middleware writes through but never listens, so this rehydrates a
 * store whenever another document wrote its key. Storage events only fire in
 * documents that did not perform the write, which is exactly the set that
 * needs to catch up.
 */
export function syncStoreAcrossDocuments(store: PersistedStore, storageKey: string): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const listener = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage || event.key !== storageKey) {
      return;
    }
    void store.persist.rehydrate();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
