import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import type { ThreadRouteTarget } from "./threadRoutes";

export type ChatPaneDirection = "row" | "column";

export interface ChatPane {
  readonly id: string;
  readonly target: ThreadRouteTarget;
}

/**
 * Two or more panes means split. The route always shows the focused pane's thread, so a pane's
 * stored target is what it shows while unfocused and what focusing it navigates to.
 */
export interface ChatPanesLayout {
  readonly direction: ChatPaneDirection;
  readonly panes: ReadonlyArray<ChatPane>;
  readonly activePaneId: string | null;
  /** The first pane's share of the split; pane minimum sizes still win over it. */
  readonly ratio: number;
}

export interface ResolvedChatPane extends ChatPane {
  readonly active: boolean;
}

export const SINGLE_CHAT_PANE_LAYOUT: ChatPanesLayout = {
  direction: "row",
  panes: [],
  activePaneId: null,
  ratio: 0.5,
};

const MIN_CHAT_PANE_RATIO = 0.1;

function clampChatPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SINGLE_CHAT_PANE_LAYOUT.ratio;
  return Math.min(1 - MIN_CHAT_PANE_RATIO, Math.max(MIN_CHAT_PANE_RATIO, ratio));
}

const MAX_CHAT_PANES = 2;

function chatPaneTargetKey(target: ThreadRouteTarget): string {
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : `draft:${target.draftId}`;
}

export function isChatSplitOpen(layout: ChatPanesLayout): boolean {
  return layout.panes.length > 1;
}

/**
 * What each pane shows for the current route. A route that lands on another pane's thread
 * focuses that pane; any other route retargets the focused pane.
 */
export function resolveChatPanes(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget,
): ReadonlyArray<ResolvedChatPane> {
  if (!isChatSplitOpen(layout)) return [];
  const routeKey = chatPaneTargetKey(routeTarget);
  const routedPane = layout.panes.find((pane) => chatPaneTargetKey(pane.target) === routeKey);
  const activePaneId =
    routedPane?.id ??
    layout.panes.find((pane) => pane.id === layout.activePaneId)?.id ??
    layout.panes[0]!.id;
  return layout.panes.map((pane) =>
    pane.id === activePaneId
      ? { id: pane.id, target: routeTarget, active: true }
      : { ...pane, active: false },
  );
}

/** Threads in unfocused panes for this route; a draft pane has no thread until it sends. */
export function backgroundChatPaneThreadRefs(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget | null,
): ReadonlyArray<ScopedThreadRef> {
  if (routeTarget === null) return [];
  return resolveChatPanes(layout, routeTarget).flatMap((pane) =>
    !pane.active && pane.target.kind === "server" ? [pane.target.threadRef] : [],
  );
}

/** The thread a restart resumes, so a split reopens as it was left: its focused pane's. */
export function chatPaneRestoreTarget(layout: ChatPanesLayout): ThreadRouteTarget | null {
  if (!isChatSplitOpen(layout)) return null;
  return layout.panes.find((pane) => pane.id === layout.activePaneId)?.target ?? null;
}

/** Records what `resolveChatPanes` showed, so it survives focus changes and restarts. */
export function commitChatPanes(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget,
): ChatPanesLayout {
  const resolved = resolveChatPanes(layout, routeTarget);
  const active = resolved.find((pane) => pane.active);
  if (!active) return layout;
  const unchanged =
    active.id === layout.activePaneId &&
    resolved.every(
      (pane, index) =>
        chatPaneTargetKey(pane.target) === chatPaneTargetKey(layout.panes[index]!.target),
    );
  if (unchanged) return layout;
  return {
    ...layout,
    panes: resolved.map(({ id, target }) => ({ id, target })),
    activePaneId: active.id,
  };
}

/**
 * Shows `target` beside the routed thread, or in the unfocused pane when already split. A thread
 * is shown in one pane at most, so one that is already visible leaves the layout as it is.
 */
export function openChatSplit(
  layout: ChatPanesLayout,
  input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
    readonly direction?: ChatPaneDirection;
    readonly createPaneId: () => string;
  },
): ChatPanesLayout {
  const targetKey = chatPaneTargetKey(input.target);
  const current = commitChatPanes(layout, input.routeTarget);
  if (current.panes.some((pane) => chatPaneTargetKey(pane.target) === targetKey)) return current;
  if (chatPaneTargetKey(input.routeTarget) === targetKey) return current;
  const direction = input.direction ?? current.direction;
  if (!isChatSplitOpen(current)) {
    const activePaneId = input.createPaneId();
    return {
      direction,
      ratio: SINGLE_CHAT_PANE_LAYOUT.ratio,
      panes: [
        { id: activePaneId, target: input.routeTarget },
        { id: input.createPaneId(), target: input.target },
      ],
      activePaneId,
    };
  }
  if (current.panes.length < MAX_CHAT_PANES) {
    return {
      ...current,
      direction,
      panes: [...current.panes, { id: input.createPaneId(), target: input.target }],
    };
  }
  const replacedIndex = current.panes.findIndex((pane) => pane.id !== current.activePaneId);
  return {
    ...current,
    direction,
    panes: current.panes.map((pane, index) =>
      index === replacedIndex ? { id: pane.id, target: input.target } : pane,
    ),
  };
}

/**
 * Removes a pane. Closing the focused pane focuses the first remaining one; `focusTarget` is the
 * thread the route should move to then, and null when the route already shows a remaining pane.
 */
export function closeChatPane(
  layout: ChatPanesLayout,
  paneId: string,
): { readonly layout: ChatPanesLayout; readonly focusTarget: ThreadRouteTarget | null } {
  const panes = layout.panes.filter((pane) => pane.id !== paneId);
  if (panes.length === layout.panes.length) return { layout, focusTarget: null };
  const closedActive = layout.activePaneId === paneId;
  const activePaneId = closedActive ? (panes[0]?.id ?? null) : layout.activePaneId;
  const focusTarget = closedActive ? (panes[0]?.target ?? null) : null;
  if (panes.length < 2)
    return { layout: { ...SINGLE_CHAT_PANE_LAYOUT, direction: layout.direction }, focusTarget };
  return { layout: { ...layout, panes, activePaneId }, focusTarget };
}

/** Trades the panes' places; each keeps its own size. */
export function swapChatPanes(layout: ChatPanesLayout): ChatPanesLayout {
  if (!isChatSplitOpen(layout)) return layout;
  return { ...layout, panes: [...layout.panes].reverse(), ratio: 1 - layout.ratio };
}

function isPersistedTarget(value: unknown): value is ThreadRouteTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  if (target.kind === "draft") return typeof target.draftId === "string";
  if (
    target.kind !== "server" ||
    typeof target.threadRef !== "object" ||
    target.threadRef === null
  ) {
    return false;
  }
  const ref = target.threadRef as Record<string, unknown>;
  return typeof ref.environmentId === "string" && typeof ref.threadId === "string";
}

function readPersistedLayout(value: unknown): ChatPanesLayout {
  if (typeof value !== "object" || value === null) return SINGLE_CHAT_PANE_LAYOUT;
  const layout = (value as { layout?: unknown }).layout as Partial<ChatPanesLayout> | undefined;
  const panes = layout?.panes;
  if (
    !Array.isArray(panes) ||
    panes.length < 2 ||
    panes.length > MAX_CHAT_PANES ||
    !panes.every((pane) => typeof pane?.id === "string" && isPersistedTarget(pane.target)) ||
    new Set(panes.map((pane) => chatPaneTargetKey(pane.target))).size !== panes.length
  ) {
    return SINGLE_CHAT_PANE_LAYOUT;
  }
  return {
    direction: layout?.direction === "column" ? "column" : "row",
    ratio: clampChatPaneRatio(typeof layout?.ratio === "number" ? layout.ratio : NaN),
    panes,
    activePaneId: typeof layout?.activePaneId === "string" ? layout.activePaneId : panes[0].id,
  };
}

interface ChatPanesStoreState {
  readonly layout: ChatPanesLayout;
  readonly commit: (routeTarget: ThreadRouteTarget) => void;
  readonly openSplit: (input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
    readonly direction?: ChatPaneDirection;
  }) => void;
  /** Returns the thread to navigate to when the focused pane closed. */
  readonly closePane: (paneId: string) => ThreadRouteTarget | null;
  readonly setRatio: (ratio: number) => void;
  readonly swap: () => void;
  readonly setDirection: (direction: ChatPaneDirection) => void;
}

export const useChatPanesStore = create<ChatPanesStoreState>()(
  persist(
    (set, get) => ({
      layout: SINGLE_CHAT_PANE_LAYOUT,
      commit: (routeTarget) =>
        set((state) => {
          const layout = commitChatPanes(state.layout, routeTarget);
          return layout === state.layout ? state : { layout };
        }),
      openSplit: (input) =>
        set((state) => ({
          layout: openChatSplit(state.layout, { ...input, createPaneId: randomUUID }),
        })),
      closePane: (paneId) => {
        const result = closeChatPane(get().layout, paneId);
        set({ layout: result.layout });
        return result.focusTarget;
      },
      setRatio: (ratio) =>
        set((state) => {
          const next = clampChatPaneRatio(ratio);
          return next === state.layout.ratio ? state : { layout: { ...state.layout, ratio: next } };
        }),
      swap: () => set((state) => ({ layout: swapChatPanes(state.layout) })),
      setDirection: (direction) =>
        set((state) =>
          state.layout.direction === direction ? state : { layout: { ...state.layout, direction } },
        ),
    }),
    {
      name: "t3code:chat-panes:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ layout: state.layout }),
      merge: (persisted, current) => ({ ...current, layout: readPersistedLayout(persisted) }),
    },
  ),
);
