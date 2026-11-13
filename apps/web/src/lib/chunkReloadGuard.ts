// Deploys and desktop server swaps can invalidate lazy chunks; one reload fetches the fresh index.
// Keyed by build and kept across boots: a chunk loaded after boot can fail on every visit.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";

export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  build = import.meta.env.APP_VERSION,
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === build;
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, build);
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

// Browsers cache a failed dynamic import per document, so only a reload can retry it.
const CHUNK_LOAD_ERROR_PREFIXES = [
  "Failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return (
    message !== undefined && CHUNK_LOAD_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}
