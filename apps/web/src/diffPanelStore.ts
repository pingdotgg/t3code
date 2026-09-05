import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "turn"; turnId: TurnId; filePath: string | null; revealRequestId: number };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };
const DEFAULT_WORKING_TREE_SELECTION: DiffPanelSelection = { kind: "unstaged" };
export const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

export interface DiffPanelViewport {
  scrollTop: number;
  fileAnchor?: { fileKey: string; offset: number };
  revealSelection: DiffPanelSelection | null;
}

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  collapsedFileKeysByScopeKey: Record<string, ReadonlySet<string>>;
  viewportByScopeKey: Record<string, DiffPanelViewport>;
  setCollapsedFileKeys: (scopeKey: string, fileKeys: ReadonlySet<string>) => void;
  setViewport: (scopeKey: string, viewport: DiffPanelViewport) => void;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: TurnId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
  removeEnvironment: (environmentId: EnvironmentId) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

function omitKeyPrefix<T>(entries: Record<string, T>, prefix: string): Record<string, T> {
  const retained = Object.entries(entries).filter(([key]) => !key.startsWith(prefix));
  return retained.length === Object.keys(entries).length ? entries : Object.fromEntries(retained);
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      collapsedFileKeysByScopeKey: {},
      viewportByScopeKey: {},
      setCollapsedFileKeys: (scopeKey, fileKeys) =>
        set((state) => ({
          collapsedFileKeysByScopeKey: {
            ...state.collapsedFileKeysByScopeKey,
            [scopeKey]: fileKeys,
          },
        })),
      setViewport: (scopeKey, viewport) =>
        set((state) => ({
          viewportByScopeKey: { ...state.viewportByScopeKey, [scopeKey]: viewport },
        })),
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
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
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const collapsedFileKeysByScopeKey = omitKeyPrefix(
            state.collapsedFileKeysByScopeKey,
            `${threadKey}:`,
          );
          const viewportByScopeKey = omitKeyPrefix(state.viewportByScopeKey, `${threadKey}:`);
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.branchBaseRefByThreadKey) &&
            collapsedFileKeysByScopeKey === state.collapsedFileKeysByScopeKey &&
            viewportByScopeKey === state.viewportByScopeKey
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return {
            byThreadKey,
            branchBaseRefByThreadKey,
            collapsedFileKeysByScopeKey,
            viewportByScopeKey,
          };
        }),
      removeEnvironment: (environmentId) =>
        set((state) => ({
          byThreadKey: omitKeyPrefix(state.byThreadKey, `${environmentId}:`),
          branchBaseRefByThreadKey: omitKeyPrefix(
            state.branchBaseRefByThreadKey,
            `${environmentId}:`,
          ),
          collapsedFileKeysByScopeKey: omitKeyPrefix(
            state.collapsedFileKeysByScopeKey,
            `${environmentId}:`,
          ),
          viewportByScopeKey: omitKeyPrefix(state.viewportByScopeKey, `${environmentId}:`),
        })),
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
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
  hasWorkingTreeChanges = false,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return (
    byThreadKey[scopedThreadKey(ref)] ??
    (hasWorkingTreeChanges ? DEFAULT_WORKING_TREE_SELECTION : DEFAULT_SELECTION)
  );
}

export function selectCollapsedDiffFileKeys(
  collapsedFileKeysByScopeKey: Record<string, ReadonlySet<string>>,
  scopeKey: string | null,
): ReadonlySet<string> {
  if (!scopeKey) return EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  return collapsedFileKeysByScopeKey[scopeKey] ?? EMPTY_COLLAPSED_DIFF_FILE_KEYS;
}
