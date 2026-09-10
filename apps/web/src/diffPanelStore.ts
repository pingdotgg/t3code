import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "turn"; turnId: TurnId; filePath: string | null; revealRequestId: number };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };
const DEFAULT_WORKING_TREE_SELECTION: DiffPanelSelection = { kind: "unstaged" };

// `scopedThreadKey` joins two ids with ":", and a repository path configured in
// t3.json rejects control characters, so NUL cannot occur inside either half of
// a repository-scoped key.
const REPOSITORY_KEY_SEPARATOR = "\u0000";

/**
 * Repository-scoped key for one thread's diff panel state. The default
 * repository is `null` — callers resolve their default to it, whatever its
 * configured path is — and maps to the bare thread key, so state persisted
 * before the panel knew about repositories keeps working without a migration.
 * Every other repository, including an explicitly picked workspace root `"."`
 * that is not the default, gets a key of its own.
 */
function diffPanelKey(ref: ScopedThreadRef, repositoryPath: string | null | undefined): string {
  const threadKey = scopedThreadKey(ref);
  if (repositoryPath === null || repositoryPath === undefined) {
    return threadKey;
  }
  return `${threadKey}${REPOSITORY_KEY_SEPARATOR}${repositoryPath}`;
}

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  /** Repository override per thread, keyed by the bare thread key. */
  selectedRepositoryByThreadKey: Record<string, string | null>;
  selectGitScope: (
    ref: ScopedThreadRef,
    scope: "branch" | "unstaged",
    repositoryPath: string | null,
  ) => void;
  selectBranchBaseRef: (
    ref: ScopedThreadRef,
    baseRef: string | null,
    repositoryPath: string | null,
  ) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: TurnId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  selectRepository: (ref: ScopedThreadRef, repositoryPath: string | null) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

/** Returns the same record when nothing matched, so unrelated state keeps its identity. */
function withoutMatchingKeys<T>(
  entries: Record<string, T>,
  matches: (key: string) => boolean,
): Record<string, T> {
  const remaining = Object.entries(entries).filter(([key]) => !matches(key));
  return remaining.length === Object.keys(entries).length ? entries : Object.fromEntries(remaining);
}

function restoreBareBranchAfterTurn(
  entries: Record<string, DiffPanelSelection>,
  threadKey: string,
  baseRef: string | null,
): Record<string, DiffPanelSelection> {
  return entries[threadKey]?.kind === "turn"
    ? { ...entries, [threadKey]: { kind: "branch", baseRef } }
    : entries;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectedRepositoryByThreadKey: {},
      selectGitScope: (ref, scope, repositoryPath) =>
        set((state) => {
          const panelKey = diffPanelKey(ref, repositoryPath);
          const previous = state.byThreadKey[panelKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[panelKey] ?? null);
          const byThreadKey = restoreBareBranchAfterTurn(
            state.byThreadKey,
            scopedThreadKey(ref),
            state.branchBaseRefByThreadKey[scopedThreadKey(ref)] ?? null,
          );
          return {
            byThreadKey: {
              ...byThreadKey,
              [panelKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [panelKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef, repositoryPath) =>
        set((state) => {
          const panelKey = diffPanelKey(ref, repositoryPath);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          const byThreadKey = restoreBareBranchAfterTurn(
            state.byThreadKey,
            scopedThreadKey(ref),
            state.branchBaseRefByThreadKey[scopedThreadKey(ref)] ?? null,
          );
          return {
            byThreadKey: {
              ...byThreadKey,
              [panelKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [panelKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          // Turn diffs come from checkpoints and cover the whole workspace rather
          // than one repository, so they live on the bare thread key and drop the
          // repository override. That also lets the chat timeline open a turn
          // without knowing which repository the panel currently shows.
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const byThreadKey = {
            ...state.byThreadKey,
            [threadKey]: {
              kind: "turn" as const,
              turnId,
              filePath: filePath?.trim() || null,
              revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
            },
          };
          if ((state.selectedRepositoryByThreadKey[threadKey] ?? null) === null) {
            return { byThreadKey };
          }
          return {
            byThreadKey,
            selectedRepositoryByThreadKey: {
              ...state.selectedRepositoryByThreadKey,
              [threadKey]: null,
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          // Checkpoint turns are workspace-wide and always live on the bare key.
          const panelKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[panelKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [panelKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      selectRepository: (ref, repositoryPath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const bareSelection = state.byThreadKey[threadKey];
          if (
            (state.selectedRepositoryByThreadKey[threadKey] ?? null) === repositoryPath &&
            bareSelection?.kind !== "turn"
          ) {
            return state;
          }
          const byThreadKey = restoreBareBranchAfterTurn(
            state.byThreadKey,
            threadKey,
            state.branchBaseRefByThreadKey[threadKey] ?? null,
          );
          return {
            byThreadKey,
            selectedRepositoryByThreadKey: {
              ...state.selectedRepositoryByThreadKey,
              [threadKey]: repositoryPath,
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const repositoryPrefix = `${threadKey}${REPOSITORY_KEY_SEPARATOR}`;
          // A thread owns one entry per repository. Matching the bare key exactly
          // and repository keys only through the separator keeps a thread whose
          // key merely starts with this one ("thread-1" vs "thread-10") intact.
          const ownedByThread = (key: string) =>
            key === threadKey || key.startsWith(repositoryPrefix);
          const byThreadKey = withoutMatchingKeys(state.byThreadKey, ownedByThread);
          const branchBaseRefByThreadKey = withoutMatchingKeys(
            state.branchBaseRefByThreadKey,
            ownedByThread,
          );
          const selectedRepositoryByThreadKey = withoutMatchingKeys(
            state.selectedRepositoryByThreadKey,
            ownedByThread,
          );
          if (
            byThreadKey === state.byThreadKey &&
            branchBaseRefByThreadKey === state.branchBaseRefByThreadKey &&
            selectedRepositoryByThreadKey === state.selectedRepositoryByThreadKey
          ) {
            return state;
          }
          return { byThreadKey, branchBaseRefByThreadKey, selectedRepositoryByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
        selectedRepositoryByThreadKey: state.selectedRepositoryByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
  repositoryPath: string | null = null,
  hasWorkingTreeChanges = false,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return (
    (byThreadKey[scopedThreadKey(ref)]?.kind === "turn"
      ? byThreadKey[scopedThreadKey(ref)]
      : undefined) ??
    byThreadKey[diffPanelKey(ref, repositoryPath)] ??
    (hasWorkingTreeChanges ? DEFAULT_WORKING_TREE_SELECTION : DEFAULT_SELECTION)
  );
}

/**
 * The repository a thread's diff panel state belongs to: its persisted choice,
 * or the configured default repository. `null` identifies the workspace root.
 *
 * A choice that is not among the currently configured repositories resolves to
 * the default. `t3.json` is checked in, so a repository can vanish under a
 * running client — and a selection that outlives its repository would key scope
 * and base ref to one repository while the panel shows another's diff. The
 * stale entry is left in place rather than cleaned up here: the configuration
 * still loads asynchronously, and resetting on an empty list would discard a
 * valid choice.
 */
export function selectThreadDiffRepositoryPath(
  selectedRepositoryByThreadKey: Record<string, string | null>,
  ref: ScopedThreadRef | null | undefined,
  configuredRepositories: ReadonlyArray<{ readonly path: string }>,
): string | null {
  if (!ref) return null;
  const selected = selectedRepositoryByThreadKey[scopedThreadKey(ref)] ?? null;
  const repositoryPath =
    selected !== null && configuredRepositories.some((repository) => repository.path === selected)
      ? selected
      : (configuredRepositories[0]?.path ?? null);
  // `null` is the stable key for the workspace root and for legacy/turn state.
  // Other configured paths, including the default, must remain path-specific so
  // reordering t3.json cannot transfer a base ref to another repository.
  return repositoryPath === "." ? null : repositoryPath;
}
