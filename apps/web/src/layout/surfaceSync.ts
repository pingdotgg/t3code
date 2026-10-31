/** Surface stores own resources; this sync owns their tabs. Hiding tabs keeps resources alive, while
 * closing a surface releases it through closeThreadSurface. */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  PULL_REQUESTS_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
  type ThreadRightPanelState,
} from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { getLayoutBehavior } from "./layoutBehavior";
import {
  createLayoutTab,
  DEFAULT_LAYOUT_COMPANION_SIZES,
  findLayoutChatForThread,
  findLayoutPane,
  findLayoutSurfaceTabs,
  findLayoutTab,
  LEGACY_PANEL_SURFACE_ID,
  measureLayoutBeside,
  selectFocusedPane,
  selectFocusedTab,
  selectFocusedWorkspace,
  shareLayoutBeside,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutCompanionKind,
  type LayoutState,
  type LayoutTab,
  type LayoutTabLocation,
  type LayoutTabPlacement,
} from "./layoutModel";
import { readableLayoutColumnShare, useLayoutStore, wasLayoutSavedBeforeLoad } from "./layoutStore";

const PULL_REQUESTS_PANEL_KEY = scopedThreadKey(PULL_REQUESTS_PANEL_REF);

/** Where the next surfaces a thread opens go, set right before opening them. */
export type LayoutSurfacePlacement =
  | { kind: "beside" }
  | { kind: "below" }
  | { kind: "pane"; paneId: string; index?: number; replaceTabId?: string }
  | { kind: "column"; workspaceId: string; index: number }
  | { kind: "workspace"; workspaceId: string };

const pendingPlacements = new Map<string, LayoutSurfacePlacement>();

/**
 * Put the thread's next opened surfaces here: beside its chat (alt+cmd+B),
 * below it (cmd+J), or in a pane (a launcher, which they replace). Holds for
 * one placement.
 */
export function requestLayoutSurfacePlacement(
  threadRef: ScopedThreadRef,
  placement: LayoutSurfacePlacement,
): void {
  pendingPlacements.set(scopedThreadKey(threadRef), placement);
  // An open that never lands (nothing to open) must not move a later one.
  setTimeout(() => {
    if (pendingPlacements.get(scopedThreadKey(threadRef)) === placement) {
      pendingPlacements.delete(scopedThreadKey(threadRef));
    }
  }, 5000);
}

function isTerminalTab(tab: LayoutTab): boolean {
  return tab.content.kind === "surface" && tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID;
}

function surfaceIdOf(tab: LayoutTab): string | null {
  return tab.content.kind === "surface" ? tab.content.surfaceId : null;
}

/** The chat tab showing a thread, a draft's included. */
export function findThreadChat(
  layout: LayoutState,
  threadRef: ScopedThreadRef,
): LayoutTabLocation | null {
  const draftId = useComposerDraftStore.getState().getDraftIdByRef(threadRef);
  return findLayoutChatForThread(layout, threadRef, draftId);
}

// The sync's own layout changes are not the user's.
let syncing = false;
function layoutUpdate(update: () => void) {
  const was = syncing;
  syncing = true;
  try {
    update();
  } finally {
    syncing = was;
  }
}

/** The remembered or template share for a beside or below placement. */
function besideShare(kind: LayoutCompanionKind): number {
  return (
    useLayoutStore.getState().companionShares[kind] ??
    getLayoutBehavior().companionShares[kind] ??
    DEFAULT_LAYOUT_COMPANION_SIZES[kind]
  );
}

/** Size the pane just placed beside or below its chat. */
export function shareWithChat(tabId: string, chatTabId: string, kind: LayoutCompanionKind) {
  useLayoutStore.setState((state) => ({
    layout: shareLayoutBeside(
      state.layout,
      tabId,
      chatTabId,
      kind,
      besideShare(kind),
      getLayoutBehavior().whenNoRoom,
      getLayoutBehavior().whenNoRoom === "shrink-then-scroll" ? readableLayoutColumnShare() : 0,
    ),
  }));
}

/** Remember how big the thread's beside or below pane was before it hides. */
function rememberShare(threadRef: ScopedThreadRef, kind: LayoutCompanionKind) {
  const layout = useLayoutStore.getState().layout;
  const chat = findThreadChat(layout, threadRef);
  if (!chat) return;
  const tab = findLayoutSurfaceTabs(layout, threadRef).find(
    (location) => isTerminalTab(location.tab) === (kind === "terminal"),
  );
  if (!tab) return;
  const share = measureLayoutBeside(
    layout,
    tab.tab.id,
    chat.tab.id,
    kind,
    getLayoutBehavior().whenNoRoom,
  );
  if (share === null) return;
  useLayoutStore.setState((state) => ({
    companionShares: { ...state.companionShares, [kind]: share },
  }));
}

/**
 * Place new surface tabs of a thread. Returns the placement used, so a beside
 * or below one can be sized.
 */
function placeSurfaceTabs(
  threadRef: ScopedThreadRef,
  tabs: LayoutTab[],
  options: { activate: string | null; focus: boolean; terminal: boolean },
): void {
  const store = useLayoutStore.getState();
  const layout = store.layout;
  const threadKey = scopedThreadKey(threadRef);
  // Below (cmd+J) is for the thread's terminal, beside (alt+cmd+B) for its
  // other surfaces; the other kind's open leaves it for its own.
  const requested = pendingPlacements.get(threadKey);
  const fits =
    requested?.kind === "below"
      ? options.terminal
      : requested?.kind === "beside"
        ? !options.terminal
        : requested !== undefined;
  const pending = fits ? requested : undefined;
  if (fits) pendingPlacements.delete(threadKey);
  const chat = findThreadChat(layout, threadRef);
  let placement: LayoutTabPlacement | null = null;
  let sizeAs: LayoutCompanionKind | null = null;
  let replaceTabId: string | null = null;
  if (
    pending?.kind === "pane" &&
    pending.replaceTabId !== undefined &&
    findLayoutTab(layout, (tab) => tab.id === pending.replaceTabId)
  ) {
    placement = { kind: "after", tabId: pending.replaceTabId! };
    replaceTabId = pending.replaceTabId!;
  } else if (pending?.kind === "pane") {
    // The pane may have closed while the open was in flight: then the default chain.
    if (findLayoutPane(layout, pending.paneId)) {
      placement = {
        kind: "pane",
        paneId: pending.paneId,
        ...(pending.index === undefined ? {} : { index: pending.index }),
      };
    }
  } else if (pending?.kind === "column") {
    if (layout.workspaces.some((workspace) => workspace.id === pending.workspaceId)) {
      placement = pending;
    }
  } else if (pending?.kind === "workspace") {
    const workspace = layout.workspaces.find((candidate) => candidate.id === pending.workspaceId);
    if (workspace) {
      placement = {
        kind: "column",
        workspaceId: workspace.id,
        index: workspace.columns.length,
      };
    }
  } else if (pending && chat) {
    placement = {
      kind: "split",
      paneId: chat.pane.id,
      side: pending.kind === "below" ? "down" : "right",
    };
    sizeAs = pending.kind === "below" ? "terminal" : "panel";
  }
  if (!placement) {
    // Next to the thread's other surfaces (its terminal keeps to itself).
    const siblings = findLayoutSurfaceTabs(layout, threadRef).filter(
      (location) =>
        isTerminalTab(location.tab) === options.terminal && !tabs.includes(location.tab),
    );
    const anchor =
      siblings.find((location) => location.pane.activeTabId === location.tab.id) ?? siblings.at(-1);
    if (anchor) placement = { kind: "after", tabId: anchor.tab.id };
    else if (chat) placement = { kind: "after", tabId: chat.tab.id };
    else {
      const pane = selectFocusedPane(layout);
      placement = pane
        ? { kind: "pane", paneId: pane.id }
        : {
            kind: "column",
            workspaceId: layout.focusedWorkspaceId,
            index: selectFocusedWorkspace(layout).columns.length,
          };
    }
  }
  layoutUpdate(() => {
    store.placeTabs(tabs, placement, {
      // A new pane shows its first tab at least.
      activate: options.activate ?? (replaceTabId !== null ? tabs[0]!.id : null),
      focus: options.focus,
    });
    if (replaceTabId !== null) store.closeTab(replaceTabId);
    if (sizeAs && chat) shareWithChat(tabs[0]!.id, chat.tab.id, sizeAs);
    if (!options.focus) {
      for (const tab of tabs) store.markTabUnseen(tab.id);
    }
  });
}

function closeTabs(ids: readonly string[]) {
  if (ids.length === 0) return;
  const set = new Set(ids);
  layoutUpdate(() => useLayoutStore.getState().closeTabsWhere((tab) => set.has(tab.id)));
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

/** Points the thread's layout tabs showing surface `from` at surface `to`. */
function retargetReplacedSurface(threadRef: ScopedThreadRef, from: string, to: string) {
  layoutUpdate(() => {
    for (const location of findLayoutSurfaceTabs(useLayoutStore.getState().layout, threadRef)) {
      if (surfaceIdOf(location.tab) !== from) continue;
      useLayoutStore
        .getState()
        .replaceTabContent(location.tab.id, { kind: "surface", threadRef, surfaceId: to });
    }
  });
}

/** Bring a thread's surface tabs in line with its store state after a change to it. */
function syncThreadSurfaces(
  threadRef: ScopedThreadRef,
  before: ThreadRightPanelState,
  after: ThreadRightPanelState,
  opened: { byUser: boolean; closing: boolean },
) {
  const layout = useLayoutStore.getState().layout;
  const tabs = findLayoutSurfaceTabs(layout, threadRef).filter(
    (location) => !isTerminalTab(location.tab),
  );
  if (!after.isOpen) {
    if (before.isOpen && tabs.length > 0) {
      rememberShare(threadRef, "panel");
      closeTabs(tabs.map((location) => location.tab.id));
    }
    return;
  }
  const ids = new Set<string>(after.surfaces.map((surface) => surface.id));
  closeTabs(
    tabs.filter((location) => !ids.has(surfaceIdOf(location.tab) ?? "")).map((l) => l.tab.id),
  );
  const placed = new Set(tabs.map((location) => surfaceIdOf(location.tab)));
  const missing = after.surfaces.filter((surface) => !placed.has(surface.id));
  const focus = opened.byUser && !opened.closing;
  if (missing.length > 0) {
    // Shown again after hiding: back together beside the chat, as alt+cmd+B does.
    if (!before.isOpen && tabs.length === 0 && !pendingPlacements.has(scopedThreadKey(threadRef))) {
      if (findThreadChat(layout, threadRef)) {
        pendingPlacements.set(scopedThreadKey(threadRef), { kind: "beside" });
      }
    }
    const newTabs = missing.map((surface) =>
      createLayoutTab({ kind: "surface", threadRef, surfaceId: surface.id }),
    );
    const active = newTabs.find((tab) => surfaceIdOf(tab) === after.activeSurfaceId);
    placeSurfaceTabs(threadRef, newTabs, {
      activate: focus ? (active?.id ?? null) : null,
      focus: focus && active !== undefined,
      terminal: false,
    });
    if (active && focus) return;
  }
  // A user's open or pick of a surface that already has a tab shows it.
  if (focus && after.activeSurfaceId !== null) {
    const tab = findLayoutSurfaceTabs(useLayoutStore.getState().layout, threadRef).find(
      (location) => surfaceIdOf(location.tab) === after.activeSurfaceId,
    );
    if (tab) layoutUpdate(() => useLayoutStore.getState().focusTab(tab.tab.id));
  }
}

/**
 * Give an open thread's surfaces that have no tab one (alt+cmd+B when the
 * store already reads open): `focus` as a user's open does.
 */
export function placeMissingSurfaceTabs(threadRef: ScopedThreadRef, focus: boolean): void {
  const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  if (!state.isOpen) return;
  syncThreadSurfaces(threadRef, EMPTY_THREAD_STATE, state, { byUser: focus, closing: false });
}

function syncThreadTerminal(threadRef: ScopedThreadRef, open: boolean, focus = true) {
  const layout = useLayoutStore.getState().layout;
  const tab = findLayoutSurfaceTabs(layout, threadRef).find((location) =>
    isTerminalTab(location.tab),
  );
  if (!open) {
    if (tab) {
      rememberShare(threadRef, "terminal");
      closeTabs([tab.tab.id]);
    }
    return;
  }
  if (tab) return;
  const newTab = createLayoutTab({
    kind: "surface",
    threadRef,
    surfaceId: THREAD_TERMINAL_SURFACE_ID,
  });
  placeSurfaceTabs(threadRef, [newTab], { activate: newTab.id, focus, terminal: true });
}

let legacySurfaceThreadKeys: Set<string> | null = null;

function adoptLegacySurfaceTabs(layout: LayoutState) {
  if (!legacySurfaceThreadKeys?.size) return;
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind !== "chat") continue;
          const target = tab.content.target;
          const draft =
            target.kind === "draft"
              ? useComposerDraftStore.getState().getDraftSession(target.draftId)
              : null;
          const threadRef =
            target.kind === "server"
              ? target.threadRef
              : draft
                ? { environmentId: draft.environmentId, threadId: draft.threadId }
                : null;
          if (!threadRef) continue;
          if (!legacySurfaceThreadKeys.delete(scopedThreadKey(threadRef))) continue;
          const focused = selectFocusedTab(useLayoutStore.getState().layout);
          const panel = selectThreadRightPanelState(
            useRightPanelStore.getState().byThreadKey,
            threadRef,
          );
          syncThreadSurfaces(threadRef, EMPTY_THREAD_STATE, panel, {
            byUser: true,
            closing: false,
          });
          if (
            selectThreadTerminalUiState(
              useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
              threadRef,
            ).terminalOpen
          ) {
            pendingPlacements.set(scopedThreadKey(threadRef), { kind: "below" });
            syncThreadTerminal(threadRef, true, false);
          }
          if (focused) layoutUpdate(() => useLayoutStore.getState().focusTab(focused.id));
        }
      }
    }
  }
}

/**
 * Once both stores have loaded: side panes saved before surfaces were tabs
 * become their surfaces' tabs, tabs whose surface is gone close, and each
 * store's open state matches what the layout shows.
 */
function reconcileOnLoad() {
  const rightPanel = useRightPanelStore.getState();
  if (legacySurfaceThreadKeys === null) {
    legacySurfaceThreadKeys = new Set(
      wasLayoutSavedBeforeLoad()
        ? []
        : [
            ...Object.entries(rightPanel.byThreadKey)
              .filter(([, state]) => state.isOpen)
              .map(([key]) => key),
            ...Object.entries(useTerminalUiStateStore.getState().terminalUiStateByThreadKey)
              .filter(([, state]) => state.terminalOpen)
              .map(([key]) => key),
          ],
    );
  }
  adoptLegacySurfaceTabs(useLayoutStore.getState().layout);
  let layout = useLayoutStore.getState().layout;
  // Legacy side panes, in place.
  const placeholders: LayoutTabLocation[] = [];
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        pane.tabs.forEach((tab, tabIndex) => {
          if (tab.content.kind === "surface" && tab.content.surfaceId === LEGACY_PANEL_SURFACE_ID) {
            placeholders.push({ workspace, column, pane, tab, tabIndex });
          }
        });
      }
    }
  }
  for (const placeholder of placeholders) {
    if (placeholder.tab.content.kind !== "surface") continue;
    const threadRef = placeholder.tab.content.threadRef;
    const state = rightPanel.byThreadKey[scopedThreadKey(threadRef)] ?? EMPTY_THREAD_STATE;
    const placed = new Set(
      findLayoutSurfaceTabs(useLayoutStore.getState().layout, threadRef).map((location) =>
        surfaceIdOf(location.tab),
      ),
    );
    const tabs = state.surfaces
      .filter((surface) => !placed.has(surface.id))
      .map((surface) => createLayoutTab({ kind: "surface", threadRef, surfaceId: surface.id }));
    const active = tabs.find((tab) => surfaceIdOf(tab) === state.activeSurfaceId) ?? tabs[0];
    layoutUpdate(() => {
      const store = useLayoutStore.getState();
      if (tabs.length > 0) {
        store.placeTabs(
          tabs,
          { kind: "after", tabId: placeholder.tab.id },
          {
            activate:
              placeholder.pane.activeTabId === placeholder.tab.id ? (active?.id ?? null) : null,
            focus: false,
          },
        );
      }
      store.closeTab(placeholder.tab.id);
    });
  }
  layout = useLayoutStore.getState().layout;
  // Tabs whose surface is gone.
  const threadKeys = new Set<string>();
  const gone: string[] = [];
  const terminalThreads: ScopedThreadRef[] = [];
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind !== "surface") continue;
          const key = scopedThreadKey(tab.content.threadRef);
          if (tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID) {
            terminalThreads.push(tab.content.threadRef);
            continue;
          }
          const state = rightPanel.byThreadKey[key];
          if (!state?.surfaces.some((surface) => surface.id === surfaceIdOfContent(tab))) {
            gone.push(tab.id);
          } else threadKeys.add(key);
        }
      }
    }
  }
  closeTabs(gone);
  // Open where the layout shows them; hidden where it does not.
  for (const [key, state] of Object.entries(useRightPanelStore.getState().byThreadKey)) {
    if (key === PULL_REQUESTS_PANEL_KEY || legacySurfaceThreadKeys.has(key)) continue;
    const threadRef = parseScopedThreadKey(key);
    if (!threadRef) continue;
    const shown = threadKeys.has(key);
    if (state.isOpen !== shown) rightPanel.syncFromLayout(threadRef, { open: shown });
  }
  // A shown thread's surface added just before a reload whose layout save never landed.
  for (const key of threadKeys) {
    const threadRef = key === PULL_REQUESTS_PANEL_KEY ? null : parseScopedThreadKey(key);
    if (threadRef) placeMissingSurfaceTabs(threadRef, false);
  }
  const terminals = useTerminalUiStateStore.getState();
  const terminalKeys = new Set(terminalThreads.map((threadRef) => scopedThreadKey(threadRef)));
  for (const threadRef of terminalThreads) {
    if (
      !selectThreadTerminalUiState(terminals.terminalUiStateByThreadKey, threadRef).terminalOpen
    ) {
      terminals.setTerminalOpen(threadRef, true);
    }
  }
  for (const [key, state] of Object.entries(terminals.terminalUiStateByThreadKey)) {
    if (!state.terminalOpen || terminalKeys.has(key) || legacySurfaceThreadKeys.has(key)) continue;
    const threadRef = parseScopedThreadKey(key);
    if (threadRef) terminals.setTerminalOpen(threadRef, false);
  }
}

function surfaceIdOfContent(tab: LayoutTab): string {
  return tab.content.kind === "surface" ? tab.content.surfaceId : "";
}

/** A layout change the sync did not make: surface tabs that went away, focus that moved. */
function onLayoutChange(layout: LayoutState, previous: LayoutState) {
  if (syncing || layout === previous) return;
  adoptLegacySurfaceTabs(layout);
  const before = surfaceTabsOf(previous);
  const after = surfaceTabsOf(layout);
  const lostByThread = new Map<string, { threadRef: ScopedThreadRef; surfaceIds: string[] }>();
  for (const [tabId, content] of before) {
    if (after.has(tabId)) continue;
    const key = scopedThreadKey(content.threadRef);
    const entry = lostByThread.get(key) ?? { threadRef: content.threadRef, surfaceIds: [] };
    entry.surfaceIds.push(content.surfaceId);
    lostByThread.set(key, entry);
  }
  for (const [key, { threadRef, surfaceIds }] of lostByThread) {
    if (surfaceIds.includes(THREAD_TERMINAL_SURFACE_ID)) {
      // A terminal's tab gone some other way hides it; its shells keep running.
      useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);
    }
    const others = surfaceIds.filter((id) => id !== THREAD_TERMINAL_SURFACE_ID);
    if (others.length === 0) continue;
    const remaining = [...after.values()].some(
      (content) =>
        scopedThreadKey(content.threadRef) === key &&
        content.surfaceId !== THREAD_TERMINAL_SURFACE_ID,
    );
    // None left: the thread's surfaces hide. Some left: the ones gone close.
    useRightPanelStore
      .getState()
      .syncFromLayout(threadRef, remaining ? { dropSurfaceIds: others } : { open: false });
  }
  // The store's shown surface follows focus.
  const focused = selectFocusedTab(layout);
  if (
    focused?.content.kind === "surface" &&
    focused.content.surfaceId !== THREAD_TERMINAL_SURFACE_ID &&
    focused.id !== selectFocusedTab(previous)?.id
  ) {
    useRightPanelStore
      .getState()
      .syncFromLayout(focused.content.threadRef, { activeSurfaceId: focused.content.surfaceId });
  }
}

function surfaceTabsOf(
  layout: LayoutState,
): Map<string, Extract<LayoutTab["content"], { kind: "surface" }>> {
  const tabs = new Map<string, Extract<LayoutTab["content"], { kind: "surface" }>>();
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind === "surface") tabs.set(tab.id, tab.content);
        }
      }
    }
  }
  return tabs;
}

let running = 0;
let stop: (() => void) | null = null;

function start(): () => void {
  reconcileOnLoad();
  const unsubscribers = [
    useRightPanelStore.subscribe((state, previous) => {
      if (state.byThreadKey === previous.byThreadKey) return;
      const keys = new Set([
        ...Object.keys(state.byThreadKey),
        ...Object.keys(previous.byThreadKey),
      ]);
      for (const key of keys) {
        if (key === PULL_REQUESTS_PANEL_KEY) continue;
        const before = previous.byThreadKey[key] ?? EMPTY_THREAD_STATE;
        const after = state.byThreadKey[key] ?? EMPTY_THREAD_STATE;
        if (before === after) continue;
        const threadRef = parseScopedThreadKey(key);
        if (!threadRef) continue;
        const replacement = state.surfaceReplacementByThreadKey[key];
        if (replacement && replacement !== previous.surfaceReplacementByThreadKey[key]) {
          retargetReplacedSurface(threadRef, replacement.from, replacement.to);
        }
        syncThreadSurfaces(threadRef, before, after, {
          byUser:
            (state.userActionRevisionByThreadKey[key] ?? 0) !==
            (previous.userActionRevisionByThreadKey[key] ?? 0),
          closing:
            (state.closeRevisionByThreadKey[key] ?? 0) !==
            (previous.closeRevisionByThreadKey[key] ?? 0),
        });
      }
    }),
    useTerminalUiStateStore.subscribe((state, previous) => {
      if (state.terminalUiStateByThreadKey === previous.terminalUiStateByThreadKey) return;
      const keys = new Set([
        ...Object.keys(state.terminalUiStateByThreadKey),
        ...Object.keys(previous.terminalUiStateByThreadKey),
      ]);
      for (const key of keys) {
        const open = state.terminalUiStateByThreadKey[key]?.terminalOpen ?? false;
        const was = previous.terminalUiStateByThreadKey[key]?.terminalOpen ?? false;
        if (open && !was) useLayoutStore.getState().showHint({ kind: "terminal", threadRef });
        if (open === was) continue;
        const threadRef = parseScopedThreadKey(key);
        if (threadRef) syncThreadTerminal(threadRef, open);
      }
    }),
    useLayoutStore.subscribe((state, previous) => onLayoutChange(state.layout, previous.layout)),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

/** Mounted by the layout host; the sync runs while any host is mounted. */
export function useLayoutSurfaceSync(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Start cross-store surface subscriptions for the first mounted host and release them after the last host leaves.
  useEffect(() => {
    running += 1;
    if (running === 1) stop = start();
    return () => {
      running -= 1;
      if (running === 0) {
        stop?.();
        stop = null;
      }
    };
  }, []);
}
