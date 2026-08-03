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

// ─── Persistence hygiene (fork: f4 F-31) ────────────────────────────────────
//
// The store used to be written with no version, no migration and no validation
// at all. A hand-edited or downgrade-written `filter: "bogus"` renders a
// `<select>` with no matching option (the browser shows the first option while
// the state says otherwise), and `activeSection: garbage` renders the History
// branch. Both maps also grew forever — every repository a draft was ever typed
// in, and every thread scope that ever existed, kept for the life of the
// install.

export const SOURCE_CONTROL_STORE_VERSION = 1;

/** Enough scopes for any plausible session; the oldest are dropped first. */
export const MAX_PERSISTED_PREF_SCOPES = 200;
/** Drafts are precious, so this is deliberately generous. */
export const MAX_PERSISTED_COMMIT_DRAFTS = 100;
/** A collapse list longer than this is corrupt, not a preference. */
const MAX_PERSISTED_LIST_ENTRIES = 2_000;
const MAX_PERSISTED_DRAFT_LENGTH = 100_000;

const SECTIONS: ReadonlyArray<SourceControlSection> = ["changes", "history"];
const VIEW_MODES: ReadonlyArray<ChangesViewMode> = ["flat", "tree"];
const FILTERS: ReadonlyArray<ChangesStatusFilter> = [
  "all",
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
];
const SORTS: ReadonlyArray<HistorySort> = ["newest", "oldest"];
const DENSITIES: ReadonlyArray<HistoryDensity> = ["compact", "comfort"];

function oneOf<T extends string>(allowed: ReadonlyArray<T>, value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length > MAX_PERSISTED_LIST_ENTRIES
    ? entries.slice(0, MAX_PERSISTED_LIST_ENTRIES)
    : entries;
}

/** Every field falls back to its default rather than rejecting the whole scope. */
export function sanitizeSourceControlPrefs(value: unknown): SourceControlPrefs {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_SOURCE_CONTROL_PREFS;
  }
  const record = value as Record<string, unknown>;
  return {
    activeSection: oneOf(
      SECTIONS,
      record.activeSection,
      DEFAULT_SOURCE_CONTROL_PREFS.activeSection,
    ),
    viewMode: oneOf(VIEW_MODES, record.viewMode, DEFAULT_SOURCE_CONTROL_PREFS.viewMode),
    filter: oneOf(FILTERS, record.filter, DEFAULT_SOURCE_CONTROL_PREFS.filter),
    collapsedGroups: stringList(record.collapsedGroups),
    collapsedFolders: stringList(record.collapsedFolders),
    stashesOpen: boolOr(record.stashesOpen, DEFAULT_SOURCE_CONTROL_PREFS.stashesOpen),
    historyGrouped: boolOr(record.historyGrouped, DEFAULT_SOURCE_CONTROL_PREFS.historyGrouped),
    historySort: oneOf(SORTS, record.historySort, DEFAULT_SOURCE_CONTROL_PREFS.historySort),
    historyDensity: oneOf(
      DENSITIES,
      record.historyDensity,
      DEFAULT_SOURCE_CONTROL_PREFS.historyDensity,
    ),
  };
}

/**
 * Validates and bounds a persisted payload of ANY shape (including one written
 * by a future version, a downgrade, or a hand edit). Never throws: a broken
 * store must degrade to defaults, not wedge the panel.
 */
export function migrateSourceControlState(persisted: unknown): {
  prefsByScope: Record<string, SourceControlPrefs>;
  commitDraftByCwd: Record<string, string>;
} {
  const record =
    typeof persisted === "object" && persisted !== null
      ? (persisted as Record<string, unknown>)
      : {};

  const prefsSource =
    typeof record.prefsByScope === "object" && record.prefsByScope !== null
      ? (record.prefsByScope as Record<string, unknown>)
      : {};
  const prefsByScope: Record<string, SourceControlPrefs> = {};
  // Insertion order is the only recency signal a JSON object carries, and
  // zustand rewrites the whole map on every set, so the tail is the newest.
  for (const key of Object.keys(prefsSource).slice(-MAX_PERSISTED_PREF_SCOPES)) {
    prefsByScope[key] = sanitizeSourceControlPrefs(prefsSource[key]);
  }

  const draftSource =
    typeof record.commitDraftByCwd === "object" && record.commitDraftByCwd !== null
      ? (record.commitDraftByCwd as Record<string, unknown>)
      : {};
  const commitDraftByCwd: Record<string, string> = {};
  for (const key of Object.keys(draftSource).slice(-MAX_PERSISTED_COMMIT_DRAFTS)) {
    const draft = draftSource[key];
    if (typeof draft !== "string" || draft.length === 0) continue;
    commitDraftByCwd[key] =
      draft.length > MAX_PERSISTED_DRAFT_LENGTH
        ? draft.slice(0, MAX_PERSISTED_DRAFT_LENGTH)
        : draft;
  }

  return { prefsByScope, commitDraftByCwd };
}

/** Drops the oldest entries once a map passes its cap. */
function capMap<T>(map: Record<string, T>, limit: number): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= limit) return map;
  const kept: Record<string, T> = {};
  for (const key of keys.slice(keys.length - limit)) {
    kept[key] = map[key] as T;
  }
  return kept;
}

export const useSourceControlStore = create<SourceControlStoreState>()(
  persist(
    (set) => ({
      prefsByScope: {},
      commitDraftByCwd: {},
      setPrefs: (scope, patch) =>
        set((state) => ({
          prefsByScope: capMap(
            {
              ...state.prefsByScope,
              [scope]: {
                ...(state.prefsByScope[scope] ?? DEFAULT_SOURCE_CONTROL_PREFS),
                ...patch,
              },
            },
            MAX_PERSISTED_PREF_SCOPES,
          ),
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
            : {
                commitDraftByCwd: capMap(
                  { ...state.commitDraftByCwd, [cwd]: message },
                  MAX_PERSISTED_COMMIT_DRAFTS,
                ),
              },
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
      // fork: f4 F-31 — validate on the way in, from ANY version. `migrate`
      // runs for a mismatched version and `merge` for every load, so both go
      // through the same sanitizer.
      version: SOURCE_CONTROL_STORE_VERSION,
      migrate: (persisted) => migrateSourceControlState(persisted),
      merge: (persisted, current) => ({ ...current, ...migrateSourceControlState(persisted) }),
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
