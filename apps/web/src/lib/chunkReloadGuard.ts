// Deploys and desktop server swaps can invalidate lazy chunks; one reload fetches the fresh index.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";

export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === "1";
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

export function clearChunkReloadGuard(getStorage: () => Storage = () => window.sessionStorage) {
  try {
    getStorage().removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {}
}

export const chunkLoadState = { failed: false, reloadScheduled: false };

// Registered from the entry before main loads, so main-chunk and route-chunk failures share one decision.
export function handleChunkLoadErrors() {
  window.addEventListener("vite:preloadError", (event) => {
    chunkLoadState.failed = true;
    if (reloadOnceForChunkLoadError()) {
      chunkLoadState.reloadScheduled = true;
      event.preventDefault();
    }
  });
}
