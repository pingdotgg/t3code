/** Surface toggles reuse saved placement and hide tabs without ending resources; ordinary opens
 * create tabs. */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  closeThreadSurface,
  hideThreadSurfaceTabs,
  hideThreadSurfaces,
} from "../components/ThreadSurfaceTab";
import { useComposerDraftStore } from "../composerDraftStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { readThreadShell } from "../state/entities";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isThreadlessSurfacesRef } from "../threadlessSurfaces";
import type { ThreadRouteTarget } from "../threadRoutes";
import {
  createLayoutLauncherContent,
  findLayoutLauncherFor,
  findLayoutTabByContent,
  findLayoutPane,
  findLayoutSurfaceTabs,
  layoutChatSwaps,
  resizeLayoutColumn,
  selectFocusedTab,
  selectFocusedWorkspace,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutState,
  type LayoutTabContent,
  type LayoutTabLocation,
  type LayoutTabDestination,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import {
  findThreadChat,
  hideThreadTerminalPane,
  layoutSurfaceDestination,
  layoutSurfacePlacement,
  placeMissingSurfaceTabs,
  requestLayoutSurfacePlacement,
  shareWithChat,
} from "./surfaceSync";

function atDestination(tab: LayoutTabLocation, chat: LayoutTabLocation, terminal: boolean) {
  const destination = layoutSurfaceDestination(chat, terminal);
  if (destination.kind === "pane") return tab.pane.id === chat.pane.id;
  if (tab.workspace.id !== chat.workspace.id) return false;
  if (destination.kind === "column") {
    return (
      tab.column.id !== chat.column.id &&
      chat.workspace.columns[terminal ? destination.index : destination.index - 1]?.id ===
        tab.column.id
    );
  }
  return terminal
    ? tab.column.id === chat.column.id &&
        chat.column.panes[chat.column.panes.indexOf(chat.pane) + 1]?.id === tab.pane.id
    : chat.workspace.columns[chat.workspace.columns.indexOf(chat.column) + 1]?.id === tab.column.id;
}

function onScreen(layout: LayoutState, location: LayoutTabLocation): boolean {
  return (
    location.pane.activeTabId === location.tab.id &&
    selectFocusedWorkspace(layout).id === location.workspace.id
  );
}

/**
 * Move tabs into one pane beside (`right`) or below (`down`) a chat's pane,
 * at the share that side remembers, showing the one that was showing.
 */
function gatherBeside(tabs: LayoutTabLocation[], chat: LayoutTabLocation, side: "right" | "down") {
  gatherAt(tabs, chat, { kind: "split", paneId: chat.pane.id, side });
}

function gatherAt(
  tabs: LayoutTabLocation[],
  chat: LayoutTabLocation,
  destination: LayoutTabDestination,
) {
  const store = useLayoutStore.getState();
  const [first, ...rest] = tabs;
  if (!first) return;
  store.moveTab(first.tab.id, destination);
  if (destination.kind === "split") {
    shareWithChat(first.tab.id, chat.tab.id, destination.side === "down" ? "terminal" : "panel");
  }
  const pane = useLayoutStore
    .getState()
    .layout.workspaces.flatMap((workspace) => workspace.columns)
    .flatMap((column) => column.panes)
    .find((candidate) => candidate.tabs.some((tab) => tab.id === first.tab.id));
  if (!pane) return;
  for (const location of rest) store.moveTab(location.tab.id, { kind: "pane", paneId: pane.id });
  const shown = tabs.find((location) => location.pane.activeTabId === location.tab.id) ?? first;
  store.focusTab(shown.tab.id);
}

/**
 * alt+cmd+B for a thread. `openDefault` opens the surface Settings says the
 * side pane opens on and returns whether it did.
 */
export function toggleThreadSidePane(threadRef: ScopedThreadRef, openDefault: () => boolean): void {
  const store = useLayoutStore.getState();
  const layout = store.layout;
  const chat = findThreadChat(layout, threadRef);
  const tabs = findLayoutSurfaceTabs(layout, threadRef).filter(
    (location) =>
      location.tab.content.kind === "surface" &&
      location.tab.content.surfaceId !== THREAD_TERMINAL_SURFACE_ID,
  );
  if (tabs.length > 0) {
    // With the chat closed there is no beside, and hiding them would leave
    // nothing of the thread to bring them back from.
    if (!chat) return;
    const besideShowing = tabs.some(
      (location) => onScreen(layout, location) && atDestination(location, chat, false),
    );
    if (besideShowing) {
      hideThreadSurfaces(threadRef);
      return;
    }
    gatherAt(tabs, chat, layoutSurfaceDestination(chat, false));
    return;
  }
  const launcher =
    chat && chat.tab.content.kind === "chat"
      ? findLayoutLauncherFor(layout, chat.tab.content.target)
      : null;
  if (launcher) {
    store.closeTab(launcher.tab.id);
    if (chat) store.focusTab(chat.tab.id);
    return;
  }
  const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  if (chat) requestLayoutSurfacePlacement(threadRef, layoutSurfacePlacement(chat, false));
  if (state.surfaces.length > 0) {
    // Open in the store with no tab shown: showing again would change nothing.
    if (state.isOpen) placeMissingSurfaceTabs(threadRef, true);
    else useRightPanelStore.getState().show(threadRef);
    return;
  }
  if (openDefault()) return;
  if (!chat || chat.tab.content.kind !== "chat") return;
  store.placeContent(
    createLayoutLauncherContent(chat.tab.content.target),
    layoutSurfaceDestination(chat, false),
  );
}

/**
 * cmd+D and cmd+L for a thread: the diff or linked pull requests tab hidden behind another
 * tab comes forward; otherwise `toggle` opens it where the side pane goes or hides it.
 */
export function toggleThreadSurfaceTab(
  threadRef: ScopedThreadRef,
  surfaceId: "diff" | "pull-requests",
  toggle: () => void,
): void {
  const layout = useLayoutStore.getState().layout;
  const tab = findLayoutSurfaceTabs(layout, threadRef).find(
    (location) =>
      location.tab.content.kind === "surface" && location.tab.content.surfaceId === surfaceId,
  );
  if (tab && !onScreen(layout, tab)) {
    useLayoutStore.getState().focusTab(tab.tab.id);
    return;
  }
  toggle();
}

/** cmd+J for a thread. `open` starts or reattaches its terminal sessions and shows them. */
export function toggleThreadTerminalPane(threadRef: ScopedThreadRef, open: () => void): void {
  const layout = useLayoutStore.getState().layout;
  const chat = findThreadChat(layout, threadRef);
  const tab = findLayoutSurfaceTabs(layout, threadRef).find(
    (location) =>
      location.tab.content.kind === "surface" &&
      location.tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID,
  );
  if (!tab) {
    if (chat) requestLayoutSurfacePlacement(threadRef, layoutSurfacePlacement(chat, true));
    open();
    return;
  }
  const placed = chat !== null && atDestination(tab, chat, true);
  if (onScreen(layout, tab) && (placed || !chat)) {
    // A threadless project's terminal has no chat to bring it back from: it
    // closes as its X does, ending its shells.
    if (isThreadlessSurfacesRef(threadRef)) {
      void closeThreadSurface(threadRef, THREAD_TERMINAL_SURFACE_ID);
      return;
    }
    if (chat) hideThreadTerminalPane(threadRef);
    else useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);
    return;
  }
  if (chat && !placed) {
    gatherAt([tab], chat, layoutSurfaceDestination(chat, true));
    useLayoutStore.getState().showHint({ kind: "terminal", threadRef });
    return;
  }
  useLayoutStore.getState().focusTab(tab.tab.id);
  useLayoutStore.getState().showHint({ kind: "terminal", threadRef });
}

/**
 * Show a thread's chat: focus its tab, or open one left of `paneId` (the
 * surface pane asking for it, e.g. a browser sending an annotation).
 */
export function showThreadChatBeside(threadRef: ScopedThreadRef, paneId: string | null): void {
  const store = useLayoutStore.getState();
  const chat = findThreadChat(store.layout, threadRef);
  if (chat) {
    store.focusTab(chat.tab.id);
    return;
  }
  const draftId = readThreadShell(threadRef)
    ? null
    : useComposerDraftStore.getState().getDraftIdByRef(threadRef);
  const target: ThreadRouteTarget = draftId
    ? { kind: "draft", draftId }
    : { kind: "server", threadRef };
  const content = { kind: "chat", target } as const;
  if (paneId !== null && findLayoutPane(store.layout, paneId)) {
    store.placeContent(content, { kind: "split", paneId, side: "left" });
  } else {
    store.openTab(content);
  }
}

/**
 * A workspace for one pull request (pen u9hG1h): move (or open) the thread
 * into a new workspace named after the PR, bring its surfaces along beside it
 * and open its terminal below it.
 */
export function openPullRequestWorkspace(threadRef: ScopedThreadRef, number: number): void {
  const store = useLayoutStore.getState();
  store.showChatInNewWorkspace({ kind: "server", threadRef }, `PR #${number}`);
  const layout = useLayoutStore.getState().layout;
  const chat = findThreadChat(layout, threadRef);
  if (chat) {
    const tabs = findLayoutSurfaceTabs(layout, threadRef);
    const isTerminal = (location: LayoutTabLocation) =>
      location.tab.content.kind === "surface" &&
      location.tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID;
    gatherBeside(
      tabs.filter((location) => !isTerminal(location)),
      chat,
      "right",
    );
    // An open terminal comes along below; opening it again would not move it.
    const terminal = tabs.find(isTerminal);
    if (terminal) gatherBeside([terminal], chat, "down");
    else requestLayoutSurfacePlacement(threadRef, { kind: "below" });
    store.focusTab(chat.tab.id);
  }
  useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
}

/** Threads whose surfaces an open hid, by thread key: they show again when an open brings it back. */
const companionsHiddenByOpen = new Map<
  string,
  {
    panel: boolean;
    terminal: boolean;
    columns: Array<{ content: LayoutTabContent; width: number; cameraWidth: number | null }>;
  }
>();

function chatThreadRef(target: ThreadRouteTarget): ScopedThreadRef | null {
  if (target.kind === "server") return target.threadRef;
  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? scopeThreadRef(draft.environmentId, draft.threadId) : null;
}

/**
 * Run an open (a sidebar click, a route) so a thread's terminal and side panes follow its chat:
 * a chat it swaps off a pane hides them, shells and browsers still running, and a chat it brings
 * back shows the ones an earlier open hid.
 */
export function followLayoutCompanions(open: () => void): void {
  const before = useLayoutStore.getState().layout;
  open();
  const after = useLayoutStore.getState().layout;
  for (const swap of layoutChatSwaps(before, after)) {
    const from = chatThreadRef(swap.from);
    const to = chatThreadRef(swap.to);
    if (from && to && scopedThreadKey(from) === scopedThreadKey(to)) continue;
    if (from) hideCompanionsOf(from, before);
    if (to) showCompanionsOf(to);
  }
}

function hideCompanionsOf(threadRef: ScopedThreadRef, layout: LayoutState) {
  const panel = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).isOpen;
  const terminal = selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  ).terminalOpen;
  if (!panel && !terminal) return;
  const chat = findThreadChat(layout, threadRef);
  const locations = [...(chat ? [chat] : []), ...findLayoutSurfaceTabs(layout, threadRef)];
  const columns = new Map(
    locations.map(({ column, tab, workspace }) => [
      column.id,
      { content: tab.content, width: column.width, cameraWidth: workspace.cameraWidth },
    ]),
  );
  companionsHiddenByOpen.set(scopedThreadKey(threadRef), {
    panel,
    terminal,
    columns: [...columns.values()],
  });
  hideThreadSurfaceTabs(threadRef);
}

function showCompanionsOf(threadRef: ScopedThreadRef) {
  const key = scopedThreadKey(threadRef);
  const hidden = companionsHiddenByOpen.get(key);
  if (!hidden) return;
  companionsHiddenByOpen.delete(key);
  const store = useLayoutStore.getState();
  const chat = findThreadChat(store.layout, threadRef);
  const focused = selectFocusedTab(store.layout);
  if (!chat) return;
  if (hidden.panel) {
    requestLayoutSurfacePlacement(threadRef, layoutSurfacePlacement(chat, false));
    useRightPanelStore.getState().syncFromLayout(threadRef, { open: true });
  }
  if (hidden.terminal) {
    requestLayoutSurfacePlacement(threadRef, layoutSurfacePlacement(chat, true));
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
  }
  if (focused) useLayoutStore.getState().focusTab(focused.id);
  // A navigation hide refits the remaining columns; returning restores the widths it borrowed.
  useLayoutStore.setState((state) => {
    let layout = state.layout;
    for (const column of hidden.columns) {
      const location = findLayoutTabByContent(layout, column.content);
      if (!location) continue;
      const scale =
        column.cameraWidth && location.workspace.cameraWidth
          ? column.cameraWidth / location.workspace.cameraWidth
          : 1;
      layout = resizeLayoutColumn(layout, location.column.id, column.width * scale);
    }
    return { layout };
  });
}
