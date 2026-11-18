/**
 * Layout actions shared by the keyboard, the tab menu and the notch buttons.
 */
import { closeThreadSurface } from "../components/ThreadSurfaceTab";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useClosedViewStore } from "../closedViewStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { getClientSettings } from "../hooks/useSettings";
import { getLayoutBehavior } from "./layoutBehavior";
import {
  createLayoutLauncherContent,
  findLayoutTab,
  findLayoutTabByContent,
  selectFocusedChatTab,
  selectFocusedTab,
  type LayoutLauncherContent,
  type LayoutOpenPlacement,
  type LayoutPane,
  type LayoutTabContent,
} from "./layoutModel";
import {
  readLastUsedProjectKey,
  resolveDefaultProjectRef,
  type NewThreadHandler,
} from "../hooks/useHandleNewThread";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadLineage, readThreadShell } from "../state/entities";
import { defaultProjectFallbackReadyAtom } from "../state/projects";
import { useUiStateStore } from "../uiStateStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { runInNewLayoutTab, setLayoutPaneTabOrder, useLayoutStore } from "./layoutStore";
import { arrangePaneStrip, drawnPaneTabIds, paneStripGroups } from "./paneStrip.logic";
import {
  paneStripThreadKeys,
  paneStripThreadStateOf,
  paneStripThreadStatesAtom,
} from "./paneStripThreadStates";
import type { LauncherSurfaceKind } from "../components/SurfaceLauncher";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { threadlessSurfacesProjectRef, threadlessSurfacesRef } from "../threadlessSurfaces";

/** The pane's tabs as its strip draws them, from the same states `usePaneSiblingTabs` reads. */
function readDrawnPaneTabIds(pane: LayoutPane): string[] {
  const settings = getClientSettings();
  const keys =
    settings.paneTabsWorkingGroup || settings.paneTabsFollowInbox ? paneStripThreadKeys(pane) : [];
  return drawnPaneTabIds(
    arrangePaneStrip({
      tabs: pane.tabs,
      activeTabId: pane.activeTabId,
      groups: paneStripGroups(pane, settings.paneTabsWorkingGroup),
      threadStateOf: paneStripThreadStateOf(
        keys,
        appAtomRegistry.get(paneStripThreadStatesAtom(keys)),
      ),
      hideSettled: settings.paneTabsFollowInbox,
    }),
  );
}
setLayoutPaneTabOrder(readDrawnPaneTabIds);

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
 * Open a launcher tab: in a new column after the focused pane (cmd+\), in a
 * new pane below it (cmd+shift+D), or in it when no project can take a new
 * thread. Focus moves to it. Its surfaces open for the thread focus was on.
 */
export function openLayoutNewTab(placement: LayoutOpenPlacement = "active-pane"): void {
  useLayoutStore.getState().openTab(createLayoutNewTabContent(), {
    placement,
    position: getLayoutBehavior().newTabPosition,
  });
}

/**
 * cmd+T and "+": a new tab holding a new thread's composer, in the project of
 * the tab focus was on, or else the default project.
 */
export async function openLayoutNewThreadTab(handleNewThread: NewThreadHandler): Promise<void> {
  const projectRef =
    launcherContextProjectRef(createLayoutNewTabContent().context) ?? readDefaultProjectRef();
  if (projectRef === null) {
    openLayoutNewTab();
    return;
  }
  await runInNewLayoutTab(() => handleNewThread(projectRef), "active-pane");
}

function launcherContextProjectRef(context: ThreadRouteTarget | null): ScopedProjectRef | null {
  if (context === null) return null;
  const drafts = useComposerDraftStore.getState();
  const draft =
    context.kind === "draft"
      ? drafts.getDraftSession(context.draftId)
      : drafts.getDraftThreadByRef(context.threadRef);
  if (draft) return scopeProjectRef(draft.environmentId, draft.projectId);
  if (context.kind === "draft") return null;
  const thread = readThreadShell(context.threadRef);
  return thread
    ? scopeProjectRef(thread.environmentId, thread.projectId)
    : threadlessSurfacesProjectRef(context.threadRef);
}

function readDefaultProjectRef(): ScopedProjectRef | null {
  const lastUsedProjectKey = readLastUsedProjectKey();
  return resolveDefaultProjectRef(
    readProjects(),
    useUiStateStore.getState().projectOrder,
    lastUsedProjectKey,
    appAtomRegistry.get(defaultProjectFallbackReadyAtom(lastUsedProjectKey)),
  );
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
          ? { kind: "server", threadRef: from.threadRef }
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
  store.closeTabByUser(tabId);
}

/**
 * Close every other tab of the tab's pane, each as its own close button would,
 * except terminals end without one confirm each (terminalCloseConfirm.ts).
 */
export function closeOtherLayoutTabsByUser(tabId: string): void {
  const store = useLayoutStore.getState();
  const location = findLayoutTab(store.layout, (candidate) => candidate.id === tabId);
  if (!location) return;
  for (const tab of location.pane.tabs) {
    if (tab.id !== tabId) closeLayoutTabByUser(tab.id, { bulk: true });
  }
  store.focusTab(tabId);
}

/** Close every tab of a group, each as its own close button would, the shown one last. */
export function closeLayoutTabGroupByUser(groupId: string): void {
  const pane = useLayoutStore
    .getState()
    .layout.workspaces.flatMap((workspace) => workspace.columns)
    .flatMap((column) => column.panes)
    .find((candidate) => candidate.groups.some((group) => group.id === groupId));
  if (!pane) return;
  const members = pane.tabs.filter((tab) => tab.groupId === groupId);
  const shown = members.filter((tab) => tab.id === pane.activeTabId);
  for (const tab of [...members.filter((tab) => !shown.includes(tab)), ...shown]) {
    closeLayoutTabByUser(tab.id, { bulk: true });
  }
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

/** Open a surface tab in the palette's originating pane, including companion panes. */
export function openLayoutBeside(kind: LayoutBesideKind): void {
  const layout = useLayoutStore.getState().layout;
  const focused = selectFocusedTab(layout);
  const origin = focused ? findLayoutTab(layout, (tab) => tab.id === focused.id) : null;
  openBesideAction?.open(kind, origin?.pane.id);
}

/** ctrl+Tab / ctrl+shift+Tab: the focused pane's tabs, surfaces included. */
export function focusAdjacentLayoutTab(delta: 1 | -1): void {
  useLayoutStore.getState().focusAdjacentTab(delta);
}
