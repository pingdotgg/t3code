import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { DraftId } from "./composerDraftStore";

export type ChatWorkspaceTarget =
  | {
      readonly kind: "server";
      readonly threadRef: ScopedThreadRef;
    }
  | {
      readonly kind: "draft";
      readonly draftId: DraftId;
    };

export interface ChatWorkspacePane {
  readonly id: string;
  readonly target: ChatWorkspaceTarget;
}

interface PersistedChatWorkspaceState {
  readonly panes?: ReadonlyArray<{
    readonly id?: unknown;
    readonly target?: unknown;
  }>;
  readonly activePaneId?: unknown;
  readonly splitRatio?: unknown;
}

export const DEFAULT_CHAT_WORKSPACE_SPLIT_RATIO = 0.5;
export const MIN_CHAT_WORKSPACE_SPLIT_RATIO = 0.25;
export const MAX_CHAT_WORKSPACE_SPLIT_RATIO = 0.75;

interface ChatWorkspaceStoreState {
  readonly panes: ReadonlyArray<ChatWorkspacePane>;
  readonly activePaneId: string | null;
  readonly splitRatio: number;
  readonly addPane: (target: ChatWorkspaceTarget) => string;
  readonly replaceActivePane: (target: ChatWorkspaceTarget) => string;
  readonly focusPane: (paneId: string) => void;
  readonly closePane: (paneId: string) => void;
  readonly reconcileRouteTarget: (target: ChatWorkspaceTarget) => void;
  readonly setSplitRatio: (ratio: number) => void;
  readonly reset: () => void;
}

const CHAT_WORKSPACE_STORAGE_KEY = "t3code:chat-workspace:v1";

function targetKey(target: ChatWorkspaceTarget): string {
  return target.kind === "server"
    ? `server:${scopedThreadKey(target.threadRef)}`
    : `draft:${target.draftId}`;
}

export function chatWorkspaceTargetKey(target: ChatWorkspaceTarget): string {
  return targetKey(target);
}

function targetEquals(left: ChatWorkspaceTarget, right: ChatWorkspaceTarget): boolean {
  return targetKey(left) === targetKey(right);
}

function clampSplitRatio(ratio: number): number {
  return Math.min(
    MAX_CHAT_WORKSPACE_SPLIT_RATIO,
    Math.max(MIN_CHAT_WORKSPACE_SPLIT_RATIO, ratio),
  );
}

function normalizeSplitRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clampSplitRatio(value)
    : DEFAULT_CHAT_WORKSPACE_SPLIT_RATIO;
}

function paneForTarget(
  panes: ReadonlyArray<ChatWorkspacePane>,
  target: ChatWorkspaceTarget,
): ChatWorkspacePane | null {
  return panes.find((pane) => targetEquals(pane.target, target)) ?? null;
}

function normalizeTarget(value: unknown): ChatWorkspaceTarget | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;

  if (candidate.kind === "draft" && typeof candidate.draftId === "string") {
    const draftId = candidate.draftId.trim();
    return draftId.length > 0 ? { kind: "draft", draftId: draftId as DraftId } : null;
  }

  if (
    candidate.kind === "server" &&
    candidate.threadRef &&
    typeof candidate.threadRef === "object"
  ) {
    const threadRef = candidate.threadRef as Record<string, unknown>;
    if (
      typeof threadRef.environmentId === "string" &&
      threadRef.environmentId.length > 0 &&
      typeof threadRef.threadId === "string" &&
      threadRef.threadId.length > 0
    ) {
      return {
        kind: "server",
        threadRef: {
          environmentId: threadRef.environmentId as ScopedThreadRef["environmentId"],
          threadId: threadRef.threadId as ScopedThreadRef["threadId"],
        },
      };
    }
  }

  return null;
}

export function parsePersistedChatWorkspaceState(value: unknown): {
  panes: ChatWorkspacePane[];
  activePaneId: string | null;
  splitRatio: number;
} {
  if (!value || typeof value !== "object") {
    return {
      panes: [],
      activePaneId: null,
      splitRatio: DEFAULT_CHAT_WORKSPACE_SPLIT_RATIO,
    };
  }

  const persisted = value as PersistedChatWorkspaceState;
  const panes: ChatWorkspacePane[] = [];
  const seenTargets = new Set<string>();
  const persistedPanes = Array.isArray(persisted.panes) ? persisted.panes : [];

  for (const candidate of persistedPanes) {
    if (!candidate || typeof candidate !== "object") continue;
    const target = normalizeTarget(candidate.target);
    if (!target) continue;
    const key = targetKey(target);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    panes.push({ id: key, target });
  }

  const activePaneId =
    typeof persisted.activePaneId === "string" &&
    panes.some((pane) => pane.id === persisted.activePaneId)
      ? persisted.activePaneId
      : (panes[0]?.id ?? null);

  return {
    panes,
    activePaneId,
    splitRatio: normalizeSplitRatio(persisted.splitRatio),
  };
}

const initialWorkspaceState = {
  panes: [] as ReadonlyArray<ChatWorkspacePane>,
  activePaneId: null as string | null,
  splitRatio: DEFAULT_CHAT_WORKSPACE_SPLIT_RATIO,
};

function storage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function getNextActivePaneId(
  panes: ReadonlyArray<ChatWorkspacePane>,
  removedPaneId: string,
): string | null {
  const removedIndex = panes.findIndex((pane) => pane.id === removedPaneId);
  if (removedIndex < 0) return panes[0]?.id ?? null;
  return panes[removedIndex + 1]?.id ?? panes[removedIndex - 1]?.id ?? null;
}

export const useChatWorkspaceStore = create<ChatWorkspaceStoreState>()(
  persist(
    (set) => ({
      ...initialWorkspaceState,

      addPane: (target) => {
        const id = targetKey(target);
        set((state) => {
          const existing = paneForTarget(state.panes, target);
          if (existing) {
            return { activePaneId: existing.id };
          }
          return {
            panes: [...state.panes, { id, target }],
            activePaneId: id,
          };
        });
        return id;
      },

      replaceActivePane: (target) => {
        const id = targetKey(target);
        set((state) => {
          const existing = paneForTarget(state.panes, target);
          if (existing) {
            return { activePaneId: existing.id };
          }
          if (state.panes.length === 0 || state.activePaneId === null) {
            return {
              panes: [{ id, target }],
              activePaneId: id,
            };
          }
          return {
            panes: state.panes.map((pane) =>
              pane.id === state.activePaneId ? { id, target } : pane,
            ),
            activePaneId: id,
          };
        });
        return id;
      },

      focusPane: (paneId) =>
        set((state) =>
          state.panes.some((pane) => pane.id === paneId) && state.activePaneId !== paneId
            ? { activePaneId: paneId }
            : state,
        ),

      closePane: (paneId) =>
        set((state) => {
          if (!state.panes.some((pane) => pane.id === paneId)) return state;
          const panes = state.panes.filter((pane) => pane.id !== paneId);
          const activePaneId =
            state.activePaneId === paneId
              ? getNextActivePaneId(state.panes, paneId)
              : state.activePaneId;
          return {
            panes,
            activePaneId:
              activePaneId && panes.some((pane) => pane.id === activePaneId)
                ? activePaneId
                : (panes[0]?.id ?? null),
          };
        }),

      reconcileRouteTarget: (target) => {
        const id = targetKey(target);
        set((state) => {
          const existing = paneForTarget(state.panes, target);
          if (existing) {
            return state.activePaneId === existing.id ? state : { activePaneId: existing.id };
          }
          if (state.panes.length === 0 || state.activePaneId === null) {
            return { panes: [{ id, target }], activePaneId: id };
          }
          return {
            panes: state.panes.map((pane) =>
              pane.id === state.activePaneId ? { id, target } : pane,
            ),
            activePaneId: id,
          };
        });
      },

      setSplitRatio: (ratio) =>
        set((state) => {
          const splitRatio = clampSplitRatio(ratio);
          return state.splitRatio === splitRatio ? state : { splitRatio };
        }),

      reset: () => set(initialWorkspaceState),
    }),
    {
      name: CHAT_WORKSPACE_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(storage),
      migrate: (persistedState) => parsePersistedChatWorkspaceState(persistedState),
      partialize: (state) => ({
        panes: state.panes,
        activePaneId: state.activePaneId,
        splitRatio: state.splitRatio,
      }),
    },
  ),
);

export function openChatThreadInSplit(threadRef: ScopedThreadRef): void {
  useChatWorkspaceStore.getState().addPane({ kind: "server", threadRef });
}
