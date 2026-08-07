/**
 * Which source folder the Git panel is pointed at, per thread.
 *
 * A project owns a primary folder plus any additional folders, and each is its
 * own repository as far as git is concerned. The panel shows one at a time and
 * remembers the choice so switching threads does not reset it.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface GitPanelStoreState {
  selectedFolderByThreadKey: Record<string, string>;
  selectFolder: (ref: ScopedThreadRef, folderPath: string) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const useGitPanelStore = create<GitPanelStoreState>()(
  persist(
    (set) => ({
      selectedFolderByThreadKey: {},
      selectFolder: (ref, folderPath) =>
        set((state) => ({
          selectedFolderByThreadKey: {
            ...state.selectedFolderByThreadKey,
            [scopedThreadKey(ref)]: folderPath,
          },
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.selectedFolderByThreadKey)) return state;
          const { [threadKey]: _removed, ...selectedFolderByThreadKey } =
            state.selectedFolderByThreadKey;
          return { selectedFolderByThreadKey };
        }),
    }),
    {
      name: "t3code:git-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        selectedFolderByThreadKey: state.selectedFolderByThreadKey,
      }),
    },
  ),
);

/**
 * The folder to show, falling back to `defaultFolderPath` whenever the stored
 * choice is gone — a folder removed from the project, or a worktree that no
 * longer exists.
 */
export function selectGitPanelFolder(
  selectedFolderByThreadKey: Record<string, string>,
  ref: ScopedThreadRef | null | undefined,
  availableFolderPaths: ReadonlyArray<string>,
  defaultFolderPath: string | null,
): string | null {
  if (!ref) return defaultFolderPath;
  const stored = selectedFolderByThreadKey[scopedThreadKey(ref)];
  if (stored && availableFolderPaths.includes(stored)) return stored;
  return defaultFolderPath;
}
