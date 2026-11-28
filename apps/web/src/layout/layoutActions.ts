/**
 * Layout actions shared by the keyboard, the tab menu and the notch buttons.
 */
import {
  agentControlledBrowserCloseConfirmationForThreads,
  closeThreadSurface,
  closeThreadSurfaces,
  readThreadSurfaceTerminalTitles,
  terminalTitlesForThreadSurface,
} from "../components/ThreadSurfaceTab";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useClosedViewStore, WORKFLOWS_PAGE_REF } from "../closedViewStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { readLocalApi } from "../localApi";
import { getLayoutBehavior } from "./layoutBehavior";
import {
  canCloseLayoutTab,
  createLayoutLauncherContent,
  findLayoutTab,
  findLayoutTabByContent,
  selectFocusedChatTab,
  selectFocusedTab,
  type LayoutLauncherContent,
  type LayoutOpenPlacement,
  type LayoutTabContent,
} from "./layoutModel";
import {
  clearPaneTabSelection,
  isLayoutTabSelected,
  readSelectedLayoutTabIds,
} from "./paneTabSelection";
import { readThreadLineage } from "../state/entities";
import { ISSUES_PANEL_REF, PULL_REQUESTS_PANEL_REF } from "../rightPanelStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { useLayoutStore } from "./layoutStore";
import { followLayoutCompanions, restoreThreadSidePaneFill } from "./openRules";
import type { LauncherSurfaceKind } from "../components/SurfaceLauncher";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { threadlessSurfacesRef } from "../threadlessSurfaces";

/** Remove a parked or discarded thread everywhere, without settling it again. */
export function closeLayoutThread(threadRef: ScopedThreadRef): void {
  const matches = (target: ThreadRouteTarget): boolean => {
    const draft =
      target.kind === "draft"
        ? useComposerDraftStore.getState().getDraftSession(target.draftId)
        : null;
    const ref =
      target.kind === "server"
        ? target.threadRef
        : draft
          ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId))
          : null;
    return ref?.environmentId === threadRef.environmentId && ref.threadId === threadRef.threadId;
  };
  const store = useLayoutStore.getState();
  store.setHiddenCompanions(scopedThreadKey(threadRef), null);
  store.closeTabsWhere((tab) =>
    tab.content.kind === "chat"
      ? matches(tab.content.target)
      : tab.content.kind === "surface" &&
        matches({ kind: "server", threadRef: tab.content.threadRef }),
  );
  // The final close leaves a launcher. It must not offer the discarded thread's surfaces.
  for (const workspace of useLayoutStore.getState().layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (
            tab.content.kind === "launcher" &&
            tab.content.context &&
            matches(tab.content.context)
          ) {
            store.replaceTabContent(tab.id, createLayoutLauncherContent(null));
          }
        }
      }
    }
  }
}

/** Project removal also clears unsent drafts and surfaces with no chat. */
export function closeLayoutProject(
  projectRef: ScopedProjectRef,
  threadRefs: readonly ScopedThreadRef[] = [],
): void {
  for (const threadRef of threadRefs) closeLayoutThread(threadRef);
  const drafts = useComposerDraftStore.getState();
  for (const [draftId, draft] of Object.entries(drafts.draftThreadsByThreadKey)) {
    if (
      draft.environmentId !== projectRef.environmentId ||
      draft.projectId !== projectRef.projectId
    )
      continue;
    closeLayoutThread(scopeThreadRef(draft.environmentId, draft.threadId));
    drafts.clearDraftThread(DraftId.make(draftId));
  }
  closeLayoutThread(threadlessSurfacesRef(projectRef.environmentId, projectRef.projectId));
}

/**
 * Open a launcher tab: in the focused pane (cmd+T, "+"), in a new column
 * after it (cmd+\), or in a new pane below it (cmd+shift+D). Focus moves to
 * it. Its surfaces open for the thread focus was on.
 */
export function openLayoutNewTab(placement: LayoutOpenPlacement = "active-pane"): void {
  useLayoutStore.getState().openTab(createLayoutNewTabContent(), {
    placement,
    position: getLayoutBehavior().newTabPosition,
  });
}

function surfaceThreadTarget(threadRef: ScopedThreadRef): ThreadRouteTarget {
  const draftId = useComposerDraftStore.getState().getDraftIdByRef(threadRef);
  return draftId !== null ? { kind: "draft", draftId } : { kind: "server", threadRef };
}

/** The launcher a new tab opened from `tabId`, or from the focused tab, shows. */
export function createLayoutNewTabContent(tabId: string | null = null): LayoutLauncherContent {
  const layout = useLayoutStore.getState().layout;
  const from = (
    tabId === null ? selectFocusedChatTab(layout) : findLayoutTab(layout, (tab) => tab.id === tabId)
  )?.tab.content;
  // A surface's launcher offers that surface's thread, as its "+" did.
  const context: ThreadRouteTarget | null =
    from?.kind === "chat"
      ? from.target
      : from?.kind === "launcher"
        ? from.context
        : from?.kind === "surface"
          ? surfaceThreadTarget(from.threadRef)
          : null;
  return createLayoutLauncherContent(context);
}

/**
 * Split a tab's pane: a tab that shares its pane moves into the new pane; a
 * pane's only tab gets a launcher beside or below it.
 */
export function splitLayoutTab(tabId: string, side: "right" | "down"): void {
  const store = useLayoutStore.getState();
  const location = findLayoutTab(store.layout, (tab) => tab.id === tabId);
  if (!location) return;
  if (location.pane.tabs.length > 1) {
    store.moveTab(tabId, { kind: "split", paneId: location.pane.id, side });
    return;
  }
  store.focusTab(tabId);
  openLayoutNewTab(side === "right" ? "new-column" : "split-down");
}

/**
 * A user's close of any tab (its close button, middle click, its menu,
 * cmd+W). A surface asks first where it runs something (a terminal, a
 * browser an agent drives) and ends its resources. Closing a chat leaves
 * its thread active.
 */
export function closeLayoutTabByUser(tabId: string, options: { bulk?: boolean } = {}): void {
  if (!options.bulk) clearPaneTabSelection();
  const store = useLayoutStore.getState();
  const location = findLayoutTab(store.layout, (candidate) => candidate.id === tabId);
  const tab = location?.tab;
  // A surface closes through its store, which closes its tab once it is done.
  if (tab?.content.kind === "surface") {
    void closeThreadSurface(tab.content.threadRef, tab.content.surfaceId, options);
    return;
  }
  if (location && tab?.content.kind === "chat") {
    const target = tab.content.target;
    const draft =
      target.kind === "draft"
        ? useComposerDraftStore.getState().getDraftSession(target.draftId)
        : null;
    const threadRef =
      target.kind === "server"
        ? target.threadRef
        : draft
          ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId))
          : null;
    if (threadRef)
      useClosedViewStore.getState().remember({
        kind: "chat",
        threadRef,
        paneId: location.pane.id,
        index: location.tabIndex,
        ...(target.kind === "draft" ? { draftId: target.draftId } : {}),
      });
    const lineage =
      threadRef && !options.bulk && selectFocusedTab(store.layout)?.id === tabId
        ? readThreadLineage(threadRef)
        : null;
    if (threadRef && lineage?.relationshipToParent === "subagent" && lineage.parentThreadId) {
      const parent: LayoutTabContent = {
        kind: "chat",
        target: {
          kind: "server",
          threadRef: scopeThreadRef(threadRef.environmentId, lineage.parentThreadId),
        },
      };
      const parentTab = findLayoutTabByContent(store.layout, parent);
      if (parentTab) {
        store.focusTab(parentTab.tab.id);
        store.closeTab(tabId);
      } else {
        store.replaceTabContent(tabId, parent);
      }
      return;
    }
  }
  if (
    location &&
    (tab?.content.kind === "issues" ||
      tab?.content.kind === "pull-requests" ||
      tab?.content.kind === "workflows")
  ) {
    useClosedViewStore.getState().remember({
      kind: "page",
      threadRef:
        tab.content.kind === "issues"
          ? ISSUES_PANEL_REF
          : tab.content.kind === "pull-requests"
            ? PULL_REQUESTS_PANEL_REF
            : WORKFLOWS_PAGE_REF,
      page: tab.content.kind,
      ...(tab.content.href === undefined ? {} : { href: tab.content.href }),
      paneId: location.pane.id,
      index: location.tabIndex,
    });
  }
  store.closeTabByUser(tabId);
}

/**
 * Close a batch of tabs from one pane together (Cmd+W, Close selected tabs,
 * close button on a selected tab). Groups surface tabs by thread so they close
 * atomically via `rightPanelStore.closeSurfaces`, and closes remaining tabs in
 * one layout store update with active remembered last for Cmd+Shift+T reopen.
 */
export function closeLayoutTabsByUser(tabIds: readonly string[]): void {
  if (tabIds.length === 0) return;
  if (tabIds.length === 1) {
    closeLayoutTabByUser(tabIds[0]!);
    return;
  }
  const initialLayout = useLayoutStore.getState().layout;
  const initialLocations = tabIds.flatMap((id) => {
    const location = findLayoutTab(initialLayout, (tab) => tab.id === id);
    return location && canCloseLayoutTab(initialLayout, id) ? [location] : [];
  });
  if (initialLocations.length === 0) return;
  if (initialLocations.length === 1) {
    closeLayoutTabByUser(initialLocations[0]!.tab.id);
    return;
  }
  const initialSurfacesByThread = new Map<
    string,
    { threadRef: ScopedThreadRef; surfaceIds: string[] }
  >();
  for (const location of initialLocations) {
    const { tab } = location;
    if (tab.content.kind !== "surface") continue;
    const key = scopedThreadKey(tab.content.threadRef);
    const entry = initialSurfacesByThread.get(key) ?? {
      threadRef: tab.content.threadRef,
      surfaceIds: [],
    };
    entry.surfaceIds.push(tab.content.surfaceId);
    initialSurfacesByThread.set(key, entry);
  }

  const finish = () => {
    clearPaneTabSelection();
    const store = useLayoutStore.getState();
    const layout = store.layout;
    const locations = tabIds.flatMap((id) => {
      const location = findLayoutTab(layout, (tab) => tab.id === id);
      return location && canCloseLayoutTab(layout, id) ? [location] : [];
    });
    if (locations.length === 0) return;
    const surfacesByThread = new Map<
      string,
      { threadRef: ScopedThreadRef; surfaceIds: string[]; activeSurfaceId: string | null }
    >();
    const inactiveNonSurfaces: typeof locations = [];
    const activeNonSurfaces: typeof locations = [];
    for (const location of locations) {
      const { tab } = location;
      const isActive = location.pane.activeTabId === tab.id;
      if (tab.content.kind === "surface") {
        const key = scopedThreadKey(tab.content.threadRef);
        const entry = surfacesByThread.get(key) ?? {
          threadRef: tab.content.threadRef,
          surfaceIds: [],
          activeSurfaceId: null,
        };
        entry.surfaceIds.push(tab.content.surfaceId);
        if (isActive) entry.activeSurfaceId = tab.content.surfaceId;
        surfacesByThread.set(key, entry);
      } else if (isActive) {
        activeNonSurfaces.push(location);
      } else {
        inactiveNonSurfaces.push(location);
      }
    }
    const rememberNonSurface = (location: (typeof locations)[number]) => {
      const { tab } = location;
      if (tab.content.kind === "chat") {
        const target = tab.content.target;
        const draft =
          target.kind === "draft"
            ? useComposerDraftStore.getState().getDraftSession(target.draftId)
            : null;
        const threadRef =
          target.kind === "server"
            ? target.threadRef
            : draft
              ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId))
              : null;
        if (threadRef) {
          useClosedViewStore.getState().remember({
            kind: "chat",
            threadRef,
            paneId: location.pane.id,
            index: location.tabIndex,
            ...(target.kind === "draft" ? { draftId: target.draftId } : {}),
          });
        }
      } else if (
        tab.content.kind === "issues" ||
        tab.content.kind === "pull-requests" ||
        tab.content.kind === "workflows"
      ) {
        useClosedViewStore.getState().remember({
          kind: "page",
          threadRef:
            tab.content.kind === "issues"
              ? ISSUES_PANEL_REF
              : tab.content.kind === "pull-requests"
                ? PULL_REQUESTS_PANEL_REF
                : WORKFLOWS_PAGE_REF,
          page: tab.content.kind,
          ...(tab.content.href === undefined ? {} : { href: tab.content.href }),
          paneId: location.pane.id,
          index: location.tabIndex,
        });
      }
    };
    // Remember inactive non-surfaces first, then close surfaces (active surface's thread last),
    // then remember any active non-surface last so Cmd+Shift+T restores the active tab first.
    for (const location of inactiveNonSurfaces) rememberNonSurface(location);
    const orderedThreadSurfaces = [...surfacesByThread.values()].toSorted(
      (left, right) =>
        Number(left.activeSurfaceId !== null) - Number(right.activeSurfaceId !== null),
    );
    for (const { threadRef, surfaceIds, activeSurfaceId } of orderedThreadSurfaces) {
      void closeThreadSurfaces(threadRef, surfaceIds, {
        bulk: true,
        skipConfirm: true,
        activeSurfaceId,
      });
    }
    for (const location of activeNonSurfaces) rememberNonSurface(location);
    const nonSurfaceIds = [...inactiveNonSurfaces, ...activeNonSurfaces].map(
      (location) => location.tab.id,
    );
    if (nonSurfaceIds.length > 0) {
      store.closeTabsByUser(nonSurfaceIds);
    }
  };

  const initialThreadSurfaces = [...initialSurfacesByThread.values()];
  const confirmTerminalsAndFinish = () => {
    const terminalLabels = initialThreadSurfaces.flatMap(({ threadRef, surfaceIds }) =>
      readThreadSurfaceTerminalTitles(threadRef, surfaceIds),
    );
    const [firstTerminalLabel, ...restTerminalLabels] = terminalLabels;
    if (firstTerminalLabel !== undefined) {
      void confirmTerminalClose([firstTerminalLabel, ...restTerminalLabels]).then((confirmed) => {
        if (confirmed) finish();
      });
      return;
    }
    finish();
  };

  const browserMessage = agentControlledBrowserCloseConfirmationForThreads(initialThreadSurfaces);
  if (browserMessage !== null) {
    const localApi = readLocalApi();
    if (!localApi) return;
    void localApi.dialogs
      .confirm(browserMessage, { variant: "destructive" })
      .catch(() => false)
      .then((confirmed) => {
        if (confirmed) confirmTerminalsAndFinish();
      });
    return;
  }
  confirmTerminalsAndFinish();
}

/** Close all selected tabs in the tab's pane when `tabId` is selected, otherwise close `tabId`. */
export function closeLayoutTabOrSelectionByUser(tabId: string): void {
  if (isLayoutTabSelected(tabId)) {
    const selected = readSelectedLayoutTabIds();
    if (selected.length >= 2) {
      closeLayoutTabsByUser(selected);
      return;
    }
  }
  closeLayoutTabByUser(tabId);
}

/**
 * Close every other tab of the tab's pane, each as its own close button would,
 * except terminals ask once together instead of once per tab (terminalCloseConfirm.ts).
 */
export function closeOtherLayoutTabsByUser(tabId: string): void {
  clearPaneTabSelection();
  const store = useLayoutStore.getState();
  const location = findLayoutTab(store.layout, (candidate) => candidate.id === tabId);
  if (!location) return;
  const siblingIds = location.pane.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id);
  const terminalTitles = location.pane.tabs.flatMap((tab) =>
    tab.id !== tabId && tab.content.kind === "surface"
      ? terminalTitlesForThreadSurface(tab.content.threadRef, tab.content.surfaceId)
      : [],
  );
  const closeSiblings = () => {
    const current = useLayoutStore.getState();
    const currentLocation = findLayoutTab(current.layout, (candidate) => candidate.id === tabId);
    if (!currentLocation) return;
    const siblingSet = new Set(siblingIds);
    for (const tab of currentLocation.pane.tabs) {
      if (siblingSet.has(tab.id)) closeLayoutTabByUser(tab.id, { bulk: true });
    }
    current.focusTab(tabId);
  };
  const [first, ...rest] = terminalTitles;
  if (first === undefined) {
    closeSiblings();
    return;
  }
  void confirmTerminalClose([first, ...rest]).then((confirmed) => {
    if (confirmed) closeSiblings();
  });
}

/** Fill the window with the focused pane, or bring the others back (alt+cmd+F). */
export function toggleFocusedLayoutFill(): void {
  const store = useLayoutStore.getState();
  const focused = selectFocusedTab(store.layout);
  if (focused) store.toggleMaximizedTab(focused.id);
}

export type LayoutBesideKind = LauncherSurfaceKind;

interface OpenBesideAction {
  readonly available: ReadonlySet<LayoutBesideKind>;
  readonly open: (
    kind: LayoutBesideKind,
    paneId?: string | null,
    browserProfileId?: string,
  ) => void;
  /** mod+alt+E: the thread's side pane fills the window. */
  readonly fillSidePane: () => void;
}
let openBesideAction: OpenBesideAction | null = null;

/**
 * The focused chat registers what it can open beside itself, so "Open
 * beside…" in the palette can open its surfaces and terminal as tabs of
 * its pane.
 */
export function registerLayoutOpenBesideAction(action: OpenBesideAction): () => void {
  openBesideAction = action;
  return () => {
    if (openBesideAction === action) openBesideAction = null;
  };
}

export function readLayoutOpenBesideKinds(): ReadonlySet<LayoutBesideKind> {
  return openBesideAction?.available ?? new Set();
}

/**
 * mod+alt+E wherever focus is: a filled pane gives the window back, otherwise the focused
 * thread's side pane fills it. False when there is no thread to fill for.
 */
export function toggleFocusedSidePaneFill(): boolean {
  if (restoreThreadSidePaneFill()) return true;
  if (!openBesideAction) return false;
  openBesideAction.fillSidePane();
  return true;
}

/** Open a surface tab in the palette's originating pane, including companion panes. */
export function openLayoutBeside(kind: LayoutBesideKind): void {
  const layout = useLayoutStore.getState().layout;
  const focused = selectFocusedTab(layout);
  const origin = focused ? findLayoutTab(layout, (tab) => tab.id === focused.id) : null;
  openBesideAction?.open(kind, origin?.pane.id);
}

/** ctrl+Tab / ctrl+shift+Tab: the focused pane's tabs, surfaces included. */
export function focusAdjacentLayoutTab(delta: 1 | -1): void {
  followLayoutCompanions(() => useLayoutStore.getState().focusAdjacentTab(delta));
}
