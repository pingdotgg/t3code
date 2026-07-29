import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { migrateWorktreeScopedRecord, readWorktreeScopedRecordValue } from "./worktreeScope";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "turn"; turnId: TurnId; filePath: string | null; revealRequestId: number };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };
const DEFAULT_WORKING_TREE_SELECTION: DiffPanelSelection = { kind: "unstaged" };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: TurnId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectGitScope: (ref, scope) =>
        set((state) => {
          const migratedSelections = migrateWorktreeScopedRecord(state.byThreadKey, ref);
          const migratedBaseRefs = migrateWorktreeScopedRecord(state.branchBaseRefByThreadKey, ref);
          const threadKey = migratedSelections.key;
          const previous = migratedSelections.record[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (migratedBaseRefs.record[threadKey] ?? null);
          return {
            byThreadKey: {
              ...migratedSelections.record,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...migratedBaseRefs.record, [threadKey]: previous.baseRef }
                : migratedBaseRefs.record,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const migratedSelections = migrateWorktreeScopedRecord(state.byThreadKey, ref);
          const migratedBaseRefs = migrateWorktreeScopedRecord(state.branchBaseRefByThreadKey, ref);
          const threadKey = migratedSelections.key;
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...migratedSelections.record,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...migratedBaseRefs.record,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const migrated = migrateWorktreeScopedRecord(state.byThreadKey, ref);
          const threadKey = migrated.key;
          const previous = migrated.record[threadKey];
          return {
            byThreadKey: {
              ...migrated.record,
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
          const migratedSelections = migrateWorktreeScopedRecord(state.byThreadKey, ref);
          const migratedBaseRefs = migrateWorktreeScopedRecord(state.branchBaseRefByThreadKey, ref);
          const threadKey = migratedSelections.key;
          const previous = migratedSelections.record[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (previous?.kind !== "turn" || availableTurnIds.includes(previous.turnId)) {
            return migratedSelections.record === state.byThreadKey &&
              migratedBaseRefs.record === state.branchBaseRefByThreadKey
              ? state
              : {
                  byThreadKey: migratedSelections.record,
                  branchBaseRefByThreadKey: migratedBaseRefs.record,
                };
          }
          return {
            byThreadKey: {
              ...migratedSelections.record,
              [threadKey]:
                latestTurnId === undefined
                  ? {
                      kind: "branch",
                      baseRef: migratedBaseRefs.record[threadKey] ?? null,
                    }
                  : { ...previous, turnId: latestTurnId, filePath: null },
            },
            branchBaseRefByThreadKey: migratedBaseRefs.record,
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const migratedSelections = migrateWorktreeScopedRecord(state.byThreadKey, ref);
          const migratedBaseRefs = migrateWorktreeScopedRecord(state.branchBaseRefByThreadKey, ref);
          const threadKey = migratedSelections.key;
          if (
            !(threadKey in migratedSelections.record) &&
            !(threadKey in migratedBaseRefs.record)
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = migratedSelections.record;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            migratedBaseRefs.record;
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      // v2 re-keyed entries from thread keys to worktree scope keys; older
      // thread-keyed entries can never match again, so they are dropped.
      version: 2,
      migrate: (persistedState, version) =>
        version < 2 || !persistedState || typeof persistedState !== "object"
          ? { byThreadKey: {}, branchBaseRefByThreadKey: {} }
          : (persistedState as {
              byThreadKey: Record<string, DiffPanelSelection>;
              branchBaseRefByThreadKey: Record<string, string | null>;
            }),
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
    readWorktreeScopedRecordValue(byThreadKey, ref) ??
    (hasWorkingTreeChanges ? DEFAULT_WORKING_TREE_SELECTION : DEFAULT_SELECTION)
  );
}
