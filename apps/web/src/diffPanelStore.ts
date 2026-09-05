import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffBaseline = TurnId | typeof THREAD_START_DIFF_BASELINE;

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | {
      kind: "turn";
      turnId: TurnId;
      filePath: string | null;
      revealRequestId: number;
      baselineTurnId?: DiffBaseline | undefined;
      followLatest?: boolean;
    };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };
const DEFAULT_WORKING_TREE_SELECTION: DiffPanelSelection = { kind: "unstaged" };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (
    ref: ScopedThreadRef,
    turnId: TurnId,
    filePath?: string,
    comparison?: { baselineTurnId?: DiffBaseline | undefined; followLatest?: boolean },
  ) => void;
  pinBaseline: (
    ref: ScopedThreadRef,
    baselineTurnId: DiffBaseline | null,
    latestTurnId: TurnId,
  ) => void;
  selectLatestTurn: (ref: ScopedThreadRef, turnId: TurnId) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
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
      selectTurn: (ref, turnId, filePath, comparison) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                ...comparison,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      pinBaseline: (ref, baselineTurnId, latestTurnId) => {
        const previous = get().byThreadKey[scopedThreadKey(ref)];
        const turnId =
          !baselineTurnId && previous?.kind === "turn" ? previous.turnId : latestTurnId;
        get().selectTurn(
          ref,
          turnId,
          undefined,
          baselineTurnId ? { baselineTurnId, followLatest: true } : undefined,
        );
      },
      selectLatestTurn: (ref, turnId) => {
        const previous = get().byThreadKey[scopedThreadKey(ref)];
        get().selectTurn(
          ref,
          turnId,
          undefined,
          previous?.kind === "turn" && previous.baselineTurnId
            ? { baselineTurnId: previous.baselineTurnId, followLatest: true }
            : undefined,
        );
      },
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (previous?.kind !== "turn") return state;
          if (latestTurnId === undefined) {
            return previous.baselineTurnId
              ? { byThreadKey: { ...state.byThreadKey, [threadKey]: DEFAULT_SELECTION } }
              : state;
          }
          const turnId =
            previous.followLatest || !availableTurnIds.includes(previous.turnId)
              ? latestTurnId
              : previous.turnId;
          const baselineTurnId =
            previous.baselineTurnId &&
            (previous.baselineTurnId === THREAD_START_DIFF_BASELINE ||
              availableTurnIds.includes(previous.baselineTurnId))
              ? previous.baselineTurnId
              : undefined;
          if (turnId === previous.turnId && baselineTurnId === previous.baselineTurnId)
            return state;
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                ...previous,
                turnId,
                baselineTurnId,
                ...(previous.followLatest ? { followLatest: baselineTurnId !== undefined } : {}),
              },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.branchBaseRefByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return { byThreadKey, branchBaseRefByThreadKey };
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

/** Compare completed snapshots; a pinned turn excludes that turn's own changes. */
export function getCheckpointDiffRange(
  toTurnCount: number | null | undefined,
  baselineTurnCount?: number | null,
) {
  if (toTurnCount == null || (baselineTurnCount != null && baselineTurnCount > toTurnCount))
    return null;
  return {
    fromTurnCount: baselineTurnCount ?? Math.max(0, toTurnCount - 1),
    toTurnCount,
  };
}

export const THREAD_START_DIFF_BASELINE = "thread-start";
