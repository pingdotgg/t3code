/**
 * Durable preferences for the source-control panel.
 *
 * Everything here is view state the user would be annoyed to lose across a
 * reload — never anything git owns. Note the one deliberate asymmetry:
 *
 *   view/collapse/history preferences are keyed **per thread scope**, because
 *   they follow the surface the user is looking at,
 *
 *   the **commit draft is keyed by `cwd`**, because a draft is about a
 *   repository. Keying it per thread would silently lose the draft on every
 *   thread switch inside one worktree, and — much worse — a project-agnostic
 *   key could commit repository A's message into repository B.
 *
 * fork: f4 source-control panel
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ChangesStatusFilter, ChangesViewMode } from "~/lib/sourceControl/changesRows";
import type { HistoryDensity } from "~/lib/sourceControl/historyRows";
import { resolveStorage } from "./lib/storage";

export type SourceControlSection = "changes" | "history";
export type HistorySort = "newest" | "oldest";

const SOURCE_CONTROL_STORAGE_KEY = "t3code:source-control-state:v1";

export interface SourceControlPrefs {
  readonly activeSection: SourceControlSection;
  readonly viewMode: ChangesViewMode;
  readonly filter: ChangesStatusFilter;
  readonly collapsedGroups: ReadonlyArray<string>;
  readonly collapsedFolders: ReadonlyArray<string>;
  readonly stashesOpen: boolean;
  readonly historyGrouped: boolean;
  readonly historySort: HistorySort;
  readonly historyDensity: HistoryDensity;
}

export const DEFAULT_SOURCE_CONTROL_PREFS: SourceControlPrefs = {
  activeSection: "changes",
  viewMode: "flat",
  filter: "all",
  collapsedGroups: [],
  collapsedFolders: [],
  stashesOpen: false,
  historyGrouped: false,
  historySort: "newest",
  historyDensity: "comfort",
};

interface SourceControlStoreState {
  /** Keyed by `scopedThreadKey(ref)`. */
  prefsByScope: Record<string, SourceControlPrefs>;
  /** Keyed by `cwd`. See the header comment — this key is load-bearing. */
  commitDraftByCwd: Record<string, string>;
  setPrefs: (scope: string, patch: Partial<SourceControlPrefs>) => void;
  toggleCollapsedGroup: (scope: string, group: string) => void;
  toggleCollapsedFolder: (scope: string, folderKey: string) => void;
  setCollapsedFolders: (scope: string, folderKeys: ReadonlyArray<string>) => void;
  setCommitDraft: (cwd: string, message: string) => void;
  clearCommitDraft: (cwd: string) => void;
}

function toggleIn(list: ReadonlyArray<string>, value: string): ReadonlyArray<string> {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export const useSourceControlStore = create<SourceControlStoreState>()(
  persist(
    (set) => ({
      prefsByScope: {},
      commitDraftByCwd: {},
      setPrefs: (scope, patch) =>
        set((state) => ({
          prefsByScope: {
            ...state.prefsByScope,
            [scope]: {
              ...(state.prefsByScope[scope] ?? DEFAULT_SOURCE_CONTROL_PREFS),
              ...patch,
            },
          },
        })),
      toggleCollapsedGroup: (scope, group) =>
        set((state) => {
          const current = state.prefsByScope[scope] ?? DEFAULT_SOURCE_CONTROL_PREFS;
          return {
            prefsByScope: {
              ...state.prefsByScope,
              [scope]: { ...current, collapsedGroups: toggleIn(current.collapsedGroups, group) },
            },
          };
        }),
      toggleCollapsedFolder: (scope, folderKey) =>
        set((state) => {
          const current = state.prefsByScope[scope] ?? DEFAULT_SOURCE_CONTROL_PREFS;
          return {
            prefsByScope: {
              ...state.prefsByScope,
              [scope]: {
                ...current,
                collapsedFolders: toggleIn(current.collapsedFolders, folderKey),
              },
            },
          };
        }),
      setCollapsedFolders: (scope, folderKeys) =>
        set((state) => {
          const current = state.prefsByScope[scope] ?? DEFAULT_SOURCE_CONTROL_PREFS;
          return {
            prefsByScope: {
              ...state.prefsByScope,
              [scope]: { ...current, collapsedFolders: [...folderKeys] },
            },
          };
        }),
      setCommitDraft: (cwd, message) =>
        set((state) =>
          state.commitDraftByCwd[cwd] === message
            ? state
            : { commitDraftByCwd: { ...state.commitDraftByCwd, [cwd]: message } },
        ),
      clearCommitDraft: (cwd) =>
        set((state) => {
          if (!(cwd in state.commitDraftByCwd)) return state;
          const { [cwd]: _removed, ...rest } = state.commitDraftByCwd;
          return { commitDraftByCwd: rest };
        }),
    }),
    {
      name: SOURCE_CONTROL_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        prefsByScope: state.prefsByScope,
        commitDraftByCwd: state.commitDraftByCwd,
      }),
    },
  ),
);

export function selectSourceControlPrefs(
  prefsByScope: Record<string, SourceControlPrefs>,
  scope: string | null,
): SourceControlPrefs {
  if (scope === null) return DEFAULT_SOURCE_CONTROL_PREFS;
  return prefsByScope[scope] ?? DEFAULT_SOURCE_CONTROL_PREFS;
}
