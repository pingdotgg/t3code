/** Layout state belongs to the device, across environments. Surface stores retain resource state;
 * surfaceSync keeps their tabs in step. */
import type { KeybindingCommand } from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { createDeferredStorage } from "../lib/storage";
import { getLayoutBehavior } from "./layoutBehavior";
import {
  arrangeLayoutWorkspaces,
  fitLayoutColumns,
  LAYOUT_READABLE_COLUMN_PX,
  closeLayoutTab,
  closeLayoutTabsWhere,
  createLayoutState,
  cycleLayoutColumnWidth,
  decodePersistedLayoutState,
  findLayoutTabByContent,
  isLayoutTabInFocusedGroup,
  focusAdjacentLayoutTab,
  focusLayoutColumnEdge,
  focusLayoutDirection,
  focusLayoutPane,
  focusLayoutTab,
  focusLayoutWorkspace,
  focusLayoutWorkspaceStep,
  moveLayoutFocused,
  moveLayoutTab,
  moveLayoutChatToColumn,
  moveLayoutTabToNewWorkspace,
  moveLayoutTabToWorkspace,
  moveLayoutWorkspace,
  renameLayoutWorkspace,
  showLayoutChatInNewWorkspace,
  openLayoutTab,
  placeLayoutContent,
  placeLayoutTabs,
  pullLayoutPane,
  replaceLayoutTabContent,
  resizeLayoutColumn,
  resizeLayoutPane,
  type LayoutCompanionKind,
  type LayoutDirection,
  type LayoutOpenOptions,
  type LayoutOpenPlacement,
  type LayoutState,
  type LayoutTab,
  type LayoutTabContent,
  type LayoutTabDestination,
  type LayoutTabPlacement,
} from "./layoutModel";
import type { ThreadRouteTarget } from "../threadRoutes";

// The strip's visible width in px, measured by the surface host. Columns
// are arranged at it (see `arrangeLayoutWorkspaces`).
let stripViewportWidth = 0;
export function setLayoutStripViewportWidth(width: number): void {
  stripViewportWidth = width;
  // A layout not drawn yet pins to the first width it is drawn at.
  const { layout } = useLayoutStore.getState();
  const pinned = arrangeLayoutWorkspaces(layout, layout, width);
  if (pinned !== layout) useLayoutStore.setState({ layout: pinned });
}

/**
 * Fit and pin the columns a change opened, closed or moved (see
 * `fitLayoutColumns`, `arrangeLayoutWorkspaces`). Every path that changes
 * the layout runs it, so the first frame already shows the fitted widths.
 */
/** The narrowest a column stays readable, as a share of the strip (Shrink, then scroll). */
export function readableLayoutColumnShare(): number {
  const width = stripViewportWidth || (typeof window === "undefined" ? 0 : window.innerWidth);
  return width > 0 ? LAYOUT_READABLE_COLUMN_PX / width : 0;
}

export function arrangeLayoutChange(before: LayoutState, after: LayoutState): LayoutState {
  if (before === after) return after;
  // A deep link opens before the strip reports its width; the window's is close.
  const fitWidth = stripViewportWidth || (typeof window === "undefined" ? 0 : window.innerWidth);
  return arrangeLayoutWorkspaces(
    before,
    fitLayoutColumns(before, after, getLayoutBehavior().whenNoRoom, fitWidth),
    stripViewportWidth,
  );
}

/**
 * A one-shot hint after a keyboard move (pen ox3jo, EZQmC) or a workspace
 * switch (OtD4i). `id` changes on every show so the same text restarts its
 * fade.
 */
export type LayoutHint =
  | { id: number; kind: "column"; index: number; count: number; command: KeybindingCommand | null }
  | {
      id: number;
      kind: "workspace";
      workspaceId: string;
      index: number;
      count: number;
      command: KeybindingCommand | null;
    }
  | { id: number; kind: "workspace-name"; workspaceId: string; index: number; count: number };

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type LayoutHintInput = WithoutId<LayoutHint>;

type ClosedThreadListener = (targets: ReadonlyArray<ThreadRouteTarget>) => void;
const closedThreadListeners = new Set<ClosedThreadListener>();

/**
 * Called with the threads a user's close (tab close, close others, cmd+W,
 * middle click) took off the layout, so they can settle. Companion closes,
 * navigation swaps and deleted threads never fire it.
 */
export function subscribeLayoutThreadsClosedByUser(listener: ClosedThreadListener): () => void {
  closedThreadListeners.add(listener);
  return () => {
    closedThreadListeners.delete(listener);
  };
}

function chatTargetsOf(layout: LayoutState): Map<string, ThreadRouteTarget> {
  const targets = new Map<string, ThreadRouteTarget>();
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind === "chat") targets.set(tab.id, tab.content.target);
        }
      }
    }
  }
  return targets;
}

/** Anticipate focus on the keypress frame before React commits. Rapid presses queue against the
 * intended layout and retarget the camera. */
type FocusUpdate = (layout: LayoutState) => LayoutState;
let anticipateFocus: ((from: LayoutState, to: LayoutState) => boolean) | null = null;
let pendingFocus: FocusUpdate[] = [];
let focusFrame: number | null = null;
let focusTimer: number | null = null;
let flushPendingFocus: () => void = () => {};

function takePendingFocus(): FocusUpdate[] {
  if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
  if (focusTimer !== null) window.clearTimeout(focusTimer);
  focusFrame = null;
  focusTimer = null;
  const updates = pendingFocus;
  pendingFocus = [];
  return updates;
}

/**
 * Returns false when the camera need not or cannot move ahead of React; the
 * focus then lands at once.
 */
export function setLayoutFocusAnticipation(
  anticipate: (from: LayoutState, to: LayoutState) => boolean,
): () => void {
  anticipateFocus = anticipate;
  return () => {
    if (anticipateFocus === anticipate) anticipateFocus = null;
  };
}

/**
 * Land queued keyboard focus now, rendering it before returning, so a key
 * that is not a layout move reaches the pane focus is going to, never the
 * one it left. False when none was queued.
 */
export function landPendingLayoutFocus(): boolean {
  if (pendingFocus.length === 0) return false;
  flushSync(flushPendingFocus);
  return true;
}

/** The layout once queued keyboard focus lands: what the next press builds on. */
export function selectIntendedLayout(): LayoutState {
  return pendingFocus.reduce((layout, update) => update(layout), useLayoutStore.getState().layout);
}

// v2: column widths are shares of the window; v1 widths do not carry over.
const LAYOUT_STORAGE_KEY = "t3code:layout-state:v2";
// Version 2: side panes and terminals are surface tabs. Older layouts decode
// their companions into them (decodePersistedLayoutState).
const LAYOUT_STORAGE_VERSION = 2;

// Focus moves, scroll settles and hints all write the store; the layout is
// serialized once they go quiet instead of on every one of them.
const layoutDeferredStorage = createDeferredStorage<StorageValue<LayoutPersistedState>>(
  typeof window !== "undefined" ? window.localStorage : undefined,
  (value) => JSON.stringify(value),
);
const layoutPersistStorage: PersistStorage<LayoutPersistedState> = {
  getItem: (name) => {
    const raw = layoutDeferredStorage.getItem(name);
    return typeof raw === "string" ? (JSON.parse(raw) as StorageValue<LayoutPersistedState>) : null;
  },
  setItem: (name, value) => layoutDeferredStorage.setItem(name, value),
  removeItem: (name) => layoutDeferredStorage.removeItem(name),
};
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => layoutDeferredStorage.flush());
}
// Read before the store saves anything, so a first run still reads as one.
const layoutSavedBeforeLoad = layoutDeferredStorage.getItem(LAYOUT_STORAGE_KEY) != null;

/**
 * Whether this device had a saved layout when the app loaded. With one, the
 * user's arrangement (an emptied one included) is what the app opens to.
 */
export function wasLayoutSavedBeforeLoad(): boolean {
  return layoutSavedBeforeLoad;
}

/**
 * Save the layout now instead of once the store goes quiet. A drag's release
 * calls it, so what the drag left drawn is what a reload restores.
 */
export function saveLayoutNow(): void {
  layoutDeferredStorage.flush();
}

/** Where the next new thread's route opens: a placement, or in place of a launcher tab. */
export type LayoutNewTabRequest = LayoutOpenPlacement | { readonly replaceTabId: string };

type LayoutPersistedState = Pick<LayoutStoreState, "layout" | "companionShares">;

interface LayoutStoreState {
  layout: LayoutState;
  /** Transient placement for a new thread route, including launcher replacement; never persist it
   * into saved layout state. */
  newTabRequest: LayoutNewTabRequest | null;
  requestNewTab: (request: LayoutNewTabRequest) => void;
  /**
   * The tab whose pane fills the strip (alt+cmd+F, the tab menu, the palette).
   * Session state: a restart shows the whole layout again.
   */
  maximizedTabId: string | null;
  toggleMaximizedTab: (tabId: string) => void;
  /**
   * The share a thread's surfaces reopen at beside (`panel`) or below
   * (`terminal`) its chat, remembered from when they last hid. A kind without
   * one opens at the layout template's share.
   */
  companionShares: Partial<Record<LayoutCompanionKind, number>>;
  /** Drop the remembered sizes, so surfaces open as Settings says again. */
  forgetCompanionShares: () => void;
  /** Put new tabs somewhere as a group (see `placeLayoutTabs`). */
  placeTabs: (
    tabs: readonly LayoutTab[],
    placement: LayoutTabPlacement,
    options: { activate: string | null; focus: boolean },
  ) => void;
  clearNewTabRequest: () => void;
  /** The zoomed-out map of every workspace (alt+cmd+O, pinch, hot corner). Session only. */
  overviewOpen: boolean;
  setOverviewOpen: (open: boolean) => void;
  /** The hint showing now, if any (LayoutHint). Session only. */
  hint: LayoutHint | null;
  showHint: (hint: LayoutHintInput) => void;
  clearHint: (id: number) => void;
  /**
   * Threads whose pane is on screen: in the focused workspace and mostly
   * inside the window, not just peeking. The strip writes it when its
   * visible panes change or its scroll settles, so the sidebar highlight
   * never follows per-frame scroll. Session only.
   */
  onScreenThreadKeys: ReadonlySet<string>;
  setOnScreenThreadKeys: (keys: ReadonlySet<string>) => void;
  /**
   * Panes an agent opened that you have not seen yet (pen uQRYP): while off
   * screen, the strip's edge shows a dot. Session only.
   */
  unseenTabIds: ReadonlySet<string>;
  markTabUnseen: (tabId: string) => void;
  markTabsSeen: (tabIds: ReadonlyArray<string>) => void;
  renameWorkspace: (workspaceId: string, name: string | null) => void;
  moveTabToNewWorkspace: (tabId: string, index: number) => void;
  moveChatToColumn: (tabId: string, workspaceId: string, index: number) => void;
  /** Give a chat a workspace of its own at the bottom of the stack (a PR's workspace). */
  showChatInNewWorkspace: (target: ThreadRouteTarget, name: string | null) => void;
  /** A user's close: threads it takes off the layout settle (subscribeLayoutThreadsClosedByUser). */
  closeTabByUser: (tabId: string) => void;
  /**
   * Focus the tab showing this chat, in any workspace, if one does. A
   * sidebar click on the thread already behind the URL (seen from the empty
   * workspace, say) changes no route, so it focuses here.
   */
  focusChat: (target: ThreadRouteTarget) => void;
  openTab: (content: LayoutTabContent, options?: LayoutOpenOptions) => void;
  replaceTabContent: (tabId: string, content: LayoutTabContent) => void;
  closeTab: (tabId: string) => void;
  closeTabsWhere: (predicate: (tab: LayoutTab) => boolean) => void;
  focusAdjacentTab: (delta: 1 | -1) => void;
  /** Resize a column measured in shares of `unitWidth`, and arrange its workspace there. */
  resizeColumnEdge: (columnId: string, width: number, unitWidth: number) => void;
  moveTab: (tabId: string, destination: LayoutTabDestination) => void;
  /** Move the tab showing this content to the destination, or open one there. */
  placeContent: (content: LayoutTabContent, destination: LayoutTabDestination) => void;
  focusTab: (tabId: string) => void;
  focusPane: (paneId: string) => void;
  focusWorkspace: (workspaceId: string) => void;
  focusDirection: (direction: LayoutDirection) => void;
  resizeColumn: (columnId: string, width: number) => void;
  cycleColumnWidth: (columnId: string) => void;
  resizePane: (paneId: string, size: number) => void;
  // The keyboard map (layoutCommands.ts).
  focusColumnEdge: (edge: "first" | "last") => void;
  moveFocused: (direction: LayoutDirection) => void;
  pullPane: (side: "left" | "right") => void;
  focusWorkspaceStep: (delta: 1 | -1) => void;
  moveTabToWorkspace: (delta: 1 | -1) => void;
  moveWorkspace: (delta: 1 | -1) => void;
  /**
   * Bumped to center the focused column in the strip (alt+cmd+C); the
   * surface host scrolls. Session only.
   */
  centerRequest: number;
  requestCenter: () => void;
  /**
   * Commit a layout derived from `from` during render (see useLayoutRouteSync),
   * so the tab ids the render used are the ones stored. Falls back to `derive`
   * when the store moved on in between.
   */
  commitDerived: (
    from: LayoutState,
    to: LayoutState,
    derive: (layout: LayoutState) => LayoutState,
  ) => void;
  reset: () => void;
}

export const useLayoutStore = create<LayoutStoreState>()(
  persist(
    (set) => {
      // Focus that leaves a maximized pane's group brings the other panes back.
      const keepMaximized = (layout: LayoutState, maximizedTabId: string | null) =>
        maximizedTabId !== null && isLayoutTabInFocusedGroup(layout, maximizedTabId)
          ? maximizedTabId
          : null;
      // Columns that open, close, move or resize are arranged at the window's
      // width now; a resize drag is arranged at the width it measures in.
      const apply = (update: (layout: LayoutState) => LayoutState, keepArrangement = false) => {
        // A click, close, resize or workspace move follows queued keypresses,
        // never a stale focus callback that steals focus back afterwards.
        const focusUpdates = takePendingFocus();
        set((state) => {
          const intended = focusUpdates.reduce((layout, focus) => focus(layout), state.layout);
          const updated = update(intended);
          if (updated === state.layout) return state;
          const layout = keepArrangement ? updated : arrangeLayoutChange(state.layout, updated);
          const maximizedTabId = keepMaximized(layout, state.maximizedTabId);
          return maximizedTabId === state.maximizedTabId ? { layout } : { layout, maximizedTabId };
        });
      };
      // Report the chat threads a user's close took off the layout.
      const closeByUser = (update: (layout: LayoutState) => LayoutState) => {
        const before = chatTargetsOf(useLayoutStore.getState().layout);
        apply(update);
        const after = chatTargetsOf(useLayoutStore.getState().layout);
        const closed = [...before].flatMap(([tabId, target]) => (after.has(tabId) ? [] : [target]));
        if (closed.length === 0) return;
        for (const listener of closedThreadListeners) listener(closed);
      };
      const flushFocus = () => {
        if (pendingFocus.length > 0) apply((layout) => layout);
      };
      flushPendingFocus = flushFocus;
      const focusSoon = (update: FocusUpdate) => {
        const from = selectIntendedLayout();
        const to = update(from);
        if (to === from) return;
        if (to.focusedWorkspaceId !== from.focusedWorkspaceId || !anticipateFocus?.(from, to)) {
          apply(update);
          return;
        }
        pendingFocus.push(update);
        // The pane focus leaves lets go of the keyboard now, as it would once
        // the store follows (usePaneKeyboard in SurfaceHost).
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest("[data-layout-strip]")) active.blur();
        if (focusTimer !== null) return;
        // After the next frame; a hidden tab draws none, so a timer backs it up.
        focusFrame = window.requestAnimationFrame(() => {
          focusFrame = null;
          if (focusTimer !== null) window.clearTimeout(focusTimer);
          focusTimer = window.setTimeout(flushFocus, 0);
        });
        focusTimer = window.setTimeout(flushFocus, 100);
      };
      let hintId = 0;
      return {
        layout: createLayoutState(),
        overviewOpen: false,
        setOverviewOpen: (open) =>
          set((state) => (state.overviewOpen === open ? state : { overviewOpen: open })),
        hint: null,
        showHint: (hint) => {
          hintId += 1;
          set({ hint: { ...hint, id: hintId } as LayoutHint });
        },
        clearHint: (id) => set((state) => (state.hint?.id === id ? { hint: null } : state)),
        onScreenThreadKeys: new Set(),
        setOnScreenThreadKeys: (keys) =>
          set((state) => {
            const current = state.onScreenThreadKeys;
            if (current.size === keys.size && [...keys].every((key) => current.has(key))) {
              return state;
            }
            return { onScreenThreadKeys: keys };
          }),
        unseenTabIds: new Set(),
        markTabUnseen: (tabId) =>
          set((state) =>
            state.unseenTabIds.has(tabId)
              ? state
              : { unseenTabIds: new Set([...state.unseenTabIds, tabId]) },
          ),
        markTabsSeen: (tabIds) =>
          set((state) => {
            if (!tabIds.some((id) => state.unseenTabIds.has(id))) return state;
            const next = new Set(state.unseenTabIds);
            for (const id of tabIds) next.delete(id);
            return { unseenTabIds: next };
          }),
        renameWorkspace: (workspaceId, name) =>
          apply((layout) => renameLayoutWorkspace(layout, workspaceId, name)),
        moveTabToNewWorkspace: (tabId, index) =>
          apply((layout) => moveLayoutTabToNewWorkspace(layout, tabId, index)),
        moveChatToColumn: (tabId, workspaceId, index) =>
          apply((layout) => moveLayoutChatToColumn(layout, tabId, workspaceId, index)),
        showChatInNewWorkspace: (target, name) =>
          apply((layout) => showLayoutChatInNewWorkspace(layout, { kind: "chat", target }, name)),
        closeTabByUser: (tabId) => closeByUser((layout) => closeLayoutTab(layout, tabId)),
        focusChat: (target) =>
          apply((layout) => {
            const existing = findLayoutTabByContent(layout, { kind: "chat", target });
            return existing ? focusLayoutTab(layout, existing.tab.id) : layout;
          }),
        newTabRequest: null,
        maximizedTabId: null,
        toggleMaximizedTab: (tabId) =>
          set((state) => {
            if (state.maximizedTabId === tabId) return { maximizedTabId: null };
            return isLayoutTabInFocusedGroup(state.layout, tabId)
              ? { maximizedTabId: tabId }
              : state;
          }),
        companionShares: {},
        forgetCompanionShares: () =>
          set((state) =>
            Object.keys(state.companionShares).length === 0 ? state : { companionShares: {} },
          ),
        placeTabs: (tabs, placement, options) =>
          apply((layout) => placeLayoutTabs(layout, tabs, placement, options)),
        requestNewTab: (request) => set({ newTabRequest: request }),
        clearNewTabRequest: () =>
          set((state) => (state.newTabRequest !== null ? { newTabRequest: null } : state)),
        openTab: (content, options) => apply((layout) => openLayoutTab(layout, content, options)),
        replaceTabContent: (tabId, content) =>
          apply((layout) => replaceLayoutTabContent(layout, tabId, content)),
        closeTab: (tabId) => apply((layout) => closeLayoutTab(layout, tabId)),
        closeTabsWhere: (predicate) => apply((layout) => closeLayoutTabsWhere(layout, predicate)),
        focusAdjacentTab: (delta) => apply((layout) => focusAdjacentLayoutTab(layout, delta)),
        resizeColumnEdge: (columnId, width, unitWidth) =>
          apply(
            (layout) =>
              arrangeLayoutWorkspaces(
                layout,
                resizeLayoutColumn(layout, columnId, width),
                unitWidth,
              ),
            true,
          ),
        moveTab: (tabId, destination) =>
          apply((layout) => moveLayoutTab(layout, tabId, destination)),
        placeContent: (content, destination) =>
          apply((layout) => placeLayoutContent(layout, content, destination)),
        focusTab: (tabId) => apply((layout) => focusLayoutTab(layout, tabId)),
        focusPane: (paneId) => apply((layout) => focusLayoutPane(layout, paneId)),
        focusWorkspace: (workspaceId) =>
          apply((layout) => focusLayoutWorkspace(layout, workspaceId)),
        focusDirection: (direction) =>
          focusSoon((layout) => focusLayoutDirection(layout, direction)),
        resizeColumn: (columnId, width) =>
          apply((layout) => resizeLayoutColumn(layout, columnId, width), true),
        cycleColumnWidth: (columnId) => apply((layout) => cycleLayoutColumnWidth(layout, columnId)),
        resizePane: (paneId, size) => apply((layout) => resizeLayoutPane(layout, paneId, size)),
        focusColumnEdge: (edge) => focusSoon((layout) => focusLayoutColumnEdge(layout, edge)),
        moveFocused: (direction) => apply((layout) => moveLayoutFocused(layout, direction)),
        pullPane: (side) => apply((layout) => pullLayoutPane(layout, side)),
        focusWorkspaceStep: (delta) => apply((layout) => focusLayoutWorkspaceStep(layout, delta)),
        moveTabToWorkspace: (delta) => apply((layout) => moveLayoutTabToWorkspace(layout, delta)),
        moveWorkspace: (delta) => apply((layout) => moveLayoutWorkspace(layout, delta)),
        centerRequest: 0,
        requestCenter: () => set((state) => ({ centerRequest: state.centerRequest + 1 })),
        commitDerived: (from, to, derive) =>
          apply((layout) => (layout === from ? to : derive(layout))),
        reset: () => set({ layout: createLayoutState() }),
      };
    },
    {
      name: LAYOUT_STORAGE_KEY,
      version: LAYOUT_STORAGE_VERSION,
      storage: layoutPersistStorage,
      partialize: (state) => ({
        layout: state.layout,
        companionShares: state.companionShares,
      }),
      // The layout decodes itself, whatever version saved it.
      migrate: (persisted) => persisted as LayoutPersistedState,
      merge: (persisted, current) => ({
        ...current,
        companionShares: decodeCompanionShares(
          persisted && typeof persisted === "object" && "companionShares" in persisted
            ? persisted.companionShares
            : null,
        ),
        layout: decodePersistedLayoutState(
          persisted && typeof persisted === "object" && "layout" in persisted
            ? persisted.layout
            : null,
        ),
      }),
    },
  ),
);

function decodeCompanionShares(value: unknown): Partial<Record<LayoutCompanionKind, number>> {
  const shares: Partial<Record<LayoutCompanionKind, number>> = {};
  for (const key of ["panel", "terminal"] as const) {
    const raw =
      value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) shares[key] = raw;
  }
  return shares;
}

/**
 * Run an action that navigates to a new thread or draft so the thread opens
 * in a new tab of the focused pane (`chat.new`), beside it, or in place of
 * the launcher tab it was started from. The request only lives until the action settles; an action that ends up not
 * navigating (the draft was already on screen) leaves no stale request.
 */
export async function runInNewLayoutTab(
  action: () => Promise<unknown>,
  request: LayoutNewTabRequest = "active-pane",
): Promise<void> {
  useLayoutStore.getState().requestNewTab(request);
  try {
    await action();
  } finally {
    // Let the route render that consumes the request land first.
    setTimeout(() => useLayoutStore.getState().clearNewTabRequest(), 0);
  }
}
