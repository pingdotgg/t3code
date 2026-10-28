import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RunId, ScopedThreadRef, ThreadId, TurnItemId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface ToolCallDiffTarget {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}

export type DiffPanelSelection =
  | ({ kind: "tool-call" } & ToolCallDiffTarget)
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "turn"; turnId: RunId; filePath: string | null; revealRequestId: number };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectToolCall: (ref: ScopedThreadRef, target: ToolCallDiffTarget) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: RunId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<RunId>) => void;
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
      selectToolCall: (ref, target) =>
        set((state) => ({
          byThreadKey: {
            ...state.byThreadKey,
            [scopedThreadKey(ref)]: { kind: "tool-call", ...target },
          },
        })),
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
      version: 2,
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

interface DiffPanelSessionStoreState {
  collapsedFileKeysByScopeKey: Record<string, ReadonlySet<string>>;
  updateCollapsedFileKeys: (
    scopeKey: string,
    defaults: ReadonlySet<string>,
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
}

// Session-only so folds survive right-panel switches without changing reload defaults.
export const useDiffPanelSessionStore = create<DiffPanelSessionStoreState>()((set) => ({
  collapsedFileKeysByScopeKey: {},
  updateCollapsedFileKeys: (scopeKey, defaults, update) =>
    set((state) => {
      const current = state.collapsedFileKeysByScopeKey[scopeKey] ?? defaults;
      const next = update(current);
      if (next === current) return state;
      return {
        collapsedFileKeysByScopeKey: { ...state.collapsedFileKeysByScopeKey, [scopeKey]: next },
      };
    }),
}));

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}

export function resolveToolCallDiffTarget(
  target: ToolCallDiffTarget,
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): ToolCallDiffTarget {
  const row = items.find(
    (row) => row.sourceThreadId === target.threadId && row.sourceItemId === target.itemId,
  );
  if (row?.item.type !== "file_change") return target;
  const revision = turnItemDetailRevision(row.item);
  return revision === target.revision ? target : { ...target, revision };
}
