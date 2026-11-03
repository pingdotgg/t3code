import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { WorktreeRepositorySelection } from "./lib/multiRepo";

const EMPTY_SELECTION: WorktreeRepositorySelection = { excludedPaths: [], baseRefs: {} };

/** Drafts keep their id until promotion; the thread id rotates when the draft is sent. */
export function worktreeRepositorySelectionKey(
  draftId: string | null | undefined,
  threadRef: ScopedThreadRef,
) {
  return draftId ?? scopedThreadKey(threadRef);
}

/**
 * The Repos chip's choices for a thread that has no task folder yet, keyed by draft id or thread
 * key. In memory only: after a reload the chip shows every repo again, the isolated default.
 */
export const useWorktreeRepositorySelectionStore = create<{
  readonly byKey: Readonly<Record<string, WorktreeRepositorySelection>>;
  readonly setIncluded: (key: string, path: string, included: boolean) => void;
  readonly setBaseRef: (key: string, path: string, baseRef: string) => void;
  readonly clear: (key: string) => void;
}>((set) => {
  const update = (
    key: string,
    change: (selection: WorktreeRepositorySelection) => WorktreeRepositorySelection,
  ) =>
    set((state) => ({
      byKey: { ...state.byKey, [key]: change(state.byKey[key] ?? EMPTY_SELECTION) },
    }));
  return {
    byKey: {},
    setIncluded: (key, path, included) =>
      update(key, (selection) => ({
        ...selection,
        excludedPaths: included
          ? selection.excludedPaths.filter((excluded) => excluded !== path)
          : [...selection.excludedPaths.filter((excluded) => excluded !== path), path],
      })),
    setBaseRef: (key, path, baseRef) =>
      update(key, (selection) => ({
        ...selection,
        baseRefs: { ...selection.baseRefs, [path]: baseRef },
      })),
    clear: (key) =>
      set((state) => {
        if (!(key in state.byKey)) return state;
        const { [key]: _cleared, ...byKey } = state.byKey;
        return { byKey };
      }),
  };
});
