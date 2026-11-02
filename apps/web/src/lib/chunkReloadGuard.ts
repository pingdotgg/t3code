// Deploys and desktop server swaps can invalidate lazy chunks; one reload fetches the fresh index.
// Keyed by build, not cleared at boot: a lazy chunk can fail after every successful boot, so a
// build reloads the tab at most once and a new deploy re-arms the guard.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";
const CURRENT_BUILD = import.meta.env.APP_VERSION || "0.0.0";

export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  build: string = CURRENT_BUILD,
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
