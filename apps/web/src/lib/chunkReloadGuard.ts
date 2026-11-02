// Deploys and desktop server swaps can invalidate lazy chunks; one reload fetches the fresh index.
// The guard expires after a delay instead of being cleared once the app boots. A successful boot
// doesn't prove that every lazy chunk loads, so clearing it there let a chunk that fails on each
// visit, such as the code highlighter blocked by a proxy, reload the page forever.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";
export const CHUNK_RELOAD_GUARD_WINDOW_MS = 5 * 60 * 1000;

export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  now: () => number = Date.now,
): boolean {
  let reloadedRecently: boolean;
  try {
    const storage = getStorage();
    const lastReloadAt = Number(storage.getItem(CHUNK_RELOAD_GUARD_KEY));
    const elapsed = now() - lastReloadAt;
    // A clock that moved backwards counts as recent, so it can't turn into a loop either.
    reloadedRecently = lastReloadAt > 0 && elapsed < CHUNK_RELOAD_GUARD_WINDOW_MS;
    if (!reloadedRecently) storage.setItem(CHUNK_RELOAD_GUARD_KEY, String(now()));
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  if (reloadedRecently) return false;
  reload();
  return true;
}
