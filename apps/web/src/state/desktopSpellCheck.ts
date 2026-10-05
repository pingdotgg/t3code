import type { DesktopBridge, DesktopSpellCheckState } from "@t3tools/contracts";

type DesktopSpellCheckBridge = Pick<DesktopBridge, "getSpellCheckState" | "setSpellCheckLanguages">;

/**
 * Desktop spell check languages, shared by every mount of the settings row so
 * revisiting the page renders in place. Changes apply optimistically; only the
 * newest change may settle the state, so a slow or failed older reply never
 * overwrites a later selection.
 */
export function createDesktopSpellCheckStore(getBridge: () => DesktopSpellCheckBridge | undefined) {
  let state: DesktopSpellCheckState | null = null;
  let changeRevision = 0;
  // The newest change still waiting on the desktop; its reply settles the state.
  let pendingChange: number | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: DesktopSpellCheckState | null) => {
    state = next;
    for (const listener of listeners) listener();
  };

  /**
   * Reads what the desktop applied. Skipped while a change is pending, and
   * dropped if a change starts before the reply arrives.
   */
  const refresh = async (): Promise<void> => {
    const getState = getBridge()?.getSpellCheckState;
    if (!getState || pendingChange !== null) return;
    const revision = changeRevision;
    try {
      const next = await getState();
      if (revision === changeRevision) publish(next);
    } catch {
      // Keep the last known state; without one the row stays hidden.
    }
  };

  /** Rejects when the desktop refused the change. */
  const setLanguages = async (languages: readonly string[]): Promise<void> => {
    const set = getBridge()?.setSpellCheckLanguages;
    // Electron falls back to en-US on an empty list, so the last one stays.
    if (!set || state === null || languages.length === 0) return;
    const revision = ++changeRevision;
    pendingChange = revision;
    publish({ ...state, languages });
    try {
      const next = await set(languages);
      if (revision === changeRevision) {
        pendingChange = null;
        publish(next);
      }
    } catch (error) {
      if (revision === changeRevision) {
        pendingChange = null;
        await refresh();
      }
      throw error;
    }
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    refresh,
    setLanguages,
  };
}

export const desktopSpellCheckStore = createDesktopSpellCheckStore(() =>
  typeof window === "undefined" ? undefined : window.desktopBridge,
);
