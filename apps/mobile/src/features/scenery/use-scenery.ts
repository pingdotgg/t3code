import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { AppState } from "react-native";

import { stableIndex } from "./alpine-theme";
import type { SceneryState } from "./scenery-store";
import { appSceneryStore, displayNamesFromState, sceneryStateAtom } from "./scenery-store";
import type { SceneryPhoto } from "./unsplash";

/** Pure resolution of a thread key's scene from published state. */
export function photoFromState(state: SceneryState, threadKey: string): SceneryPhoto | null {
  if (state.pool.length === 0) return null;
  const assignedId = state.assignments[threadKey];
  if (assignedId !== undefined) {
    const assigned = state.pool.find((photo) => photo.id === assignedId);
    if (assigned) return assigned;
  }
  return state.pool[stableIndex(threadKey, state.pool.length)] ?? null;
}

/** The scene bound to a thread key; null while the pool is empty. */
export function useSceneryPhoto(threadKey: string | null): SceneryPhoto | null {
  const state = useAtomValue(sceneryStateAtom);
  return threadKey === null ? null : photoFromState(state, threadKey);
}

/**
 * Two-line thread naming ("Seceda" primary / "Fix the flaky retry test"
 * description), reactive to scene assignment and pool changes. Mirrors the
 * mac sidebar's `scenery.displayNames(for:)`. Falls back to `{ primary:
 * title.trim(), description: null }` when the thread has no resolvable scene
 * (no thread key, no Unsplash key, or an empty pool) so callers render
 * exactly the pre-scenery title-only row.
 */
export function useThreadDisplayNames(
  threadKey: string | null,
  title: string,
): { readonly primary: string; readonly description: string | null } {
  const state = useAtomValue(sceneryStateAtom);
  if (threadKey === null) return { primary: title.trim(), description: null };
  return displayNamesFromState(state, threadKey, title);
}

/** Daily-rotating hero for empty states. */
export function useDailyFeatured(): SceneryPhoto | null {
  const state = useAtomValue(sceneryStateAtom);
  if (state.featuredPhotoId === null) return null;
  return state.pool.find((photo) => photo.id === state.featuredPhotoId) ?? null;
}

export function useSceneryReady(): boolean {
  return useAtomValue(sceneryStateAtom).ready;
}

/**
 * Kick the scenery system once at app root: initial disk load / pool
 * refresh, plus a daily-featured recompute whenever the app returns to the
 * foreground (so the hero rolls over at midnight without a relaunch).
 */
export function useSceneryBootstrap(): void {
  useEffect(() => {
    void appSceneryStore.start();
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        appSceneryStore.refreshDailyFeatured();
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);
}
