import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { randomUUID } from "./lib/utils";
import type { ThreadRouteTarget } from "./threadRoutes";

export interface ChatPane {
  readonly id: string;
  readonly target: ThreadRouteTarget;
}

/**
 * Two panes means split. The route always shows the focused pane's thread, so a pane's stored
 * target is what it shows while unfocused and what focusing it navigates to.
 */
export interface ChatPanesLayout {
  readonly panes: ReadonlyArray<ChatPane>;
  readonly activePaneId: string | null;
}

export interface ResolvedChatPane extends ChatPane {
  readonly active: boolean;
}

export const SINGLE_CHAT_PANE_LAYOUT: ChatPanesLayout = { panes: [], activePaneId: null };

/** The one pane's id before any split; a split keeps it for the routed pane, so it stays mounted. */
const PRIMARY_CHAT_PANE_ID = "primary";

function chatPaneTargetKey(target: ThreadRouteTarget): string {
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : `draft:${target.draftId}`;
}

export function isChatSplitOpen(layout: ChatPanesLayout): boolean {
  return layout.panes.length > 1;
}

/**
 * What each pane shows for the current route. A route that lands on the other pane's thread
 * focuses that pane; any other route retargets the focused pane.
 */
export function resolveChatPanes(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget,
): ReadonlyArray<ResolvedChatPane> {
  if (!isChatSplitOpen(layout)) {
    return [{ id: layout.panes[0]?.id ?? PRIMARY_CHAT_PANE_ID, target: routeTarget, active: true }];
  }
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

/**
 * Threads the unfocused pane shows for this route; a draft pane has no thread until it sends.
 * None while the window is too narrow for the split, since only the focused pane renders then.
 */
export function backgroundChatPaneThreadRefs(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget | null,
  splitFits: boolean,
): ReadonlyArray<ScopedThreadRef> {
  if (routeTarget === null || !splitFits) return [];
  return resolveChatPanes(layout, routeTarget).flatMap((pane) =>
    !pane.active && pane.target.kind === "server" ? [pane.target.threadRef] : [],
  );
}

/** Records what `resolveChatPanes` showed, so the unfocused pane keeps its thread. */
export function commitChatPanes(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget,
): ChatPanesLayout {
  if (!isChatSplitOpen(layout)) return layout;
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
    readonly createPaneId: () => string;
  },
): ChatPanesLayout {
  const targetKey = chatPaneTargetKey(input.target);
  const current = commitChatPanes(layout, input.routeTarget);
  if (chatPaneTargetKey(input.routeTarget) === targetKey) return current;
  // A single pane's stored target can be stale; only a split shows its panes' targets.
  if (
    isChatSplitOpen(current) &&
    current.panes.some((pane) => chatPaneTargetKey(pane.target) === targetKey)
  ) {
    return current;
  }
  if (!isChatSplitOpen(current)) {
    const activePaneId = current.panes[0]?.id ?? PRIMARY_CHAT_PANE_ID;
    return {
      panes: [
        { id: activePaneId, target: input.routeTarget },
        { id: input.createPaneId(), target: input.target },
      ],
      activePaneId,
    };
  }
  return {
    ...current,
    panes: current.panes.map((pane) =>
      pane.id === current.activePaneId ? pane : { id: pane.id, target: input.target },
    ),
  };
}

/**
 * Removes a pane. Closing the focused pane focuses the other; `focusTarget` is the thread the
 * route should move to then, and null when the route already shows the remaining pane.
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
  // The remaining pane keeps its id, so it stays mounted as the single pane.
  return { layout: { panes, activePaneId }, focusTarget };
}

interface ChatPanesStoreState {
  readonly layout: ChatPanesLayout;
  /** Whether the chat area is wide enough to render both panes of a split. */
  readonly splitFits: boolean;
  readonly setSplitFits: (splitFits: boolean) => void;
  readonly commit: (routeTarget: ThreadRouteTarget) => void;
  readonly openSplit: (input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
  }) => void;
  /** Returns the thread to navigate to when the focused pane closed. */
  readonly closePane: (paneId: string) => ThreadRouteTarget | null;
}

// In memory only: a split lasts until it is closed or the app reloads.
export const useChatPanesStore = create<ChatPanesStoreState>()((set, get) => ({
  layout: SINGLE_CHAT_PANE_LAYOUT,
  splitFits: true,
  setSplitFits: (splitFits) =>
    set((state) => (state.splitFits === splitFits ? state : { splitFits })),
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
}));
