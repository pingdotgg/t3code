import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveTerminalActivityStatus } from "@t3tools/client-runtime/state/terminal";
import type {
  ContextMenuItem,
  KeybindingCommand,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { create } from "zustand";
import { useAtomValue } from "@effect/atom-react";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import {
  ChartNoAxesColumnIcon,
  GitForkIcon,
  PanelRightIcon,
  SettingsIcon,
  SquareDashedIcon,
  SquarePenIcon,
  SquareTerminal,
  XIcon,
} from "lucide-react";
import {
  memo,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import {
  isThreadlessHomeRef,
  isThreadlessSurfacesRef,
  readThreadlessHome,
  threadlessSurfacesProjectRef,
  useThreadlessHome,
} from "../threadlessSurfaces";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { canShareWithGuestAtom } from "../components/chat/guestShareAvailability";
import { previewBridge } from "../components/preview/previewBridge";
import { useThreadActionMenu } from "../hooks/useThreadActionMenu";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { ContentButton } from "../components/ui/button";
import { cn } from "../lib/utils";
import { PANE_GHOST_TAB_TITLE_CLASS, PANE_INACTIVE_TAB_TITLE_CLASS } from "../components/PaneNotch";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { ThreadSurfaceTabIcon } from "../components/SurfaceTabIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  readThreadPreviewState,
  useThreadPreviewState,
  type DesktopPreviewOverlay,
} from "../previewStateStore";
import { contextMenuShortcutFields, shortcutLabelForCommand } from "../keybindings";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { isElectron } from "../env";
import { textDirection } from "../textDirection";
import { buildThreadRouteParams } from "../threadRoutes";
import { toastManager } from "../components/ui/toast";
import { readProject, readThreadShell, useProject, useQuietThreadShell } from "../state/entities";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  countLayoutTabs,
  findLayoutPane,
  findLayoutTab,
  isLayoutGhostTab,
  isLayoutGhostTabShown,
  isLayoutPageContent,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutState,
  type LayoutTab,
} from "./layoutModel";
import { closeLayoutTabByUser, closeOtherLayoutTabsByUser, splitLayoutTab } from "./layoutActions";
import { beginLayoutTabDrag } from "./layoutDrag";
import { useLayoutPane } from "./layoutPaneContext";
import { isScrollingWorkspacesEnabled } from "./layoutBehavior";
import { useLayoutStore } from "./layoutStore";
import { setWheelScroller, wheelDeltaPx } from "../motion/gesture";
import { observeResize } from "../lib/observeResize";
import { surfaceTabTitle, terminalTabTitle } from "./surfaceTabLabels";

const EMPTY_TABS: readonly LayoutTab[] = [];

/** Keep overflow reachable by wheel and touch, and reveal the selected tab without moving its pane. */
export function LayoutPaneTabStrip({ children }: { children: ReactNode }) {
  const { tabId } = useLayoutPane();
  const stripRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the tab scroller's wheel routing and reveal its active tab after header resizing.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tab = [...strip.querySelectorAll<HTMLElement>("[data-layout-pane-tab]")].find(
      (candidate) => candidate.dataset.layoutPaneTab === tabId,
    );
    const reveal = () => {
      if (!tab) return;
      const bounds = strip.getBoundingClientRect();
      const rect = tab.getBoundingClientRect();
      // A file tab's trailing breadcrumb names the file; reveal it before its thread label.
      if (rect.width > bounds.width && tab.dataset.layoutTabReveal === "end")
        strip.scrollLeft += rect.right - bounds.right;
      else if (rect.left < bounds.left) strip.scrollLeft -= bounds.left - rect.left;
      else if (rect.right > bounds.right) strip.scrollLeft += rect.right - bounds.right;
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || strip.scrollWidth <= strip.clientWidth)
        return;
      event.preventDefault();
      event.stopPropagation();
      strip.scrollLeft += wheelDeltaPx(
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY,
        event,
      );
    };
    setWheelScroller(strip, () => strip.scrollWidth > strip.clientWidth);
    strip.addEventListener("wheel", wheel, { passive: false });
    const stop = observeResize(tab ? [strip, tab] : [strip], reveal);
    reveal();
    return () => {
      stop();
      setWheelScroller(strip, null);
      strip.removeEventListener("wheel", wheel);
    };
  }, [tabId]);
  return (
    <div
      ref={stripRef}
      data-layout-tab-strip=""
      className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </div>
  );
}

/**
 * The other tabs of the pane this chat renders in, split around the active
 * one so the notch lists them in order (pen R49C1s: active tab, then the
 * pane's other tabs, then "+"). Empty outside a layout host.
 */
export function useLayoutPaneSiblingTabs(): {
  before: readonly LayoutTab[];
  after: readonly LayoutTab[];
} {
  const { tabId, paneId } = useLayoutPane();
  return usePaneSiblingTabs(paneId, tabId);
}

/** The same for a pane and tab named outright, outside their pane's context. */
export function usePaneSiblingTabs(
  paneId: string | null,
  tabId: string | null,
): {
  before: readonly LayoutTab[];
  after: readonly LayoutTab[];
} {
  const pane = useLayoutStore((state) =>
    paneId === null ? null : (findLayoutPane(state.layout, paneId)?.pane ?? null),
  );
  return (() => {
    if (!pane || tabId === null || pane.tabs.length < 2) {
      return { before: EMPTY_TABS, after: EMPTY_TABS };
    }
    const index = pane.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return { before: EMPTY_TABS, after: EMPTY_TABS };
    return { before: pane.tabs.slice(0, index), after: pane.tabs.slice(index + 1) };
  })();
}

export type LayoutTabMenuId =
  | "layout:keep"
  | "layout:split-right"
  | "layout:split-down"
  | "layout:new-column"
  | "layout:new-workspace"
  | "layout:fill"
  | "layout:copy-link"
  | "layout:close-tab"
  | "layout:close-other-tabs";

/** Layout actions for a tab's context menu (pen lLm7Y 3). Every tab can close. */
export function buildLayoutTabMenuItems(
  layout: LayoutState,
  tabId: string,
  keybindings: ResolvedKeybindingsConfig = [],
): ContextMenuItem<LayoutTabMenuId>[] {
  const keys = (command: KeybindingCommand) => contextMenuShortcutFields(keybindings, command);
  const location = findLayoutTab(layout, (tab) => tab.id === tabId);
  if (!location) return [];
  const paneCount = location.workspace.columns.reduce(
    (sum, column) => sum + column.panes.length,
    0,
  );
  const hasSiblings = location.pane.tabs.length > 1;
  const items: ContextMenuItem<LayoutTabMenuId>[] = [
    ...(isLayoutGhostTab(location.tab)
      ? [{ id: "layout:keep", label: "Keep open", icon: "pin" } as const]
      : []),
    {
      id: "layout:split-right",
      label: "Split right",
      icon: "panel-right",
      ...keys("layout.splitRight"),
    },
    {
      id: "layout:split-down",
      label: "Split down",
      icon: "panel-bottom",
      ...keys("layout.splitDown"),
    },
  ];
  if (hasSiblings || paneCount > 1) {
    items.push({ id: "layout:new-column", label: "Move to a new column", icon: "columns-2" });
  }
  if (isScrollingWorkspacesEnabled() && countLayoutTabs(layout) > 1) {
    items.push({ id: "layout:new-workspace", label: "Move to a new workspace", icon: "layers-2" });
  }
  if (paneCount > 1) {
    const filled = useLayoutStore.getState().maximizedTabId === tabId;
    items.push({
      id: "layout:fill",
      label: filled ? "Show every pane" : "Fill the window",
      icon: "maximize",
      ...keys("layout.fill"),
    });
  }
  if (location.tab.content.kind === "chat" && location.tab.content.target.kind === "server") {
    items.push({
      id: "layout:copy-link",
      label: "Copy link",
      icon: "link",
      separatorBefore: true,
    });
  }
  items.push({
    id: "layout:close-tab",
    label: "Close",
    icon: "x",
    ...keys("tab.close"),
    separatorBefore: !items.some((item) => item.id === "layout:copy-link"),
  });
  if (hasSiblings) {
    items.push({ id: "layout:close-other-tabs", label: "Close others", icon: "copy-x" });
  }
  return items;
}

export function isLayoutTabMenuId(id: string): id is LayoutTabMenuId {
  return id.startsWith("layout:");
}

/** The app URL of a thread, as it opens in a browser or another window. */
function threadLinkFor(tab: LayoutTab): string | null {
  if (tab.content.kind !== "chat" || tab.content.target.kind !== "server") return null;
  const { environmentId, threadId } = buildThreadRouteParams(tab.content.target.threadRef);
  const path = `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  return isElectron
    ? `${window.location.origin}${window.location.pathname}#${path}`
    : `${window.location.origin}${path}`;
}

export function runLayoutTabMenuAction(action: LayoutTabMenuId, tabId: string): void {
  const store = useLayoutStore.getState();
  const location = findLayoutTab(store.layout, (tab) => tab.id === tabId);
  if (!location) return;
  switch (action) {
    case "layout:keep":
      store.keepTab(tabId);
      return;
    case "layout:split-right":
      splitLayoutTab(tabId, "right");
      return;
    case "layout:split-down":
      splitLayoutTab(tabId, "down");
      return;
    case "layout:new-column": {
      const columnIndex = location.workspace.columns.indexOf(location.column);
      store.moveTab(tabId, {
        kind: "column",
        workspaceId: location.workspace.id,
        index: columnIndex + 1,
      });
      return;
    }
    case "layout:new-workspace": {
      if (!isScrollingWorkspacesEnabled()) return;
      const index = store.layout.workspaces.indexOf(location.workspace);
      store.moveTabToNewWorkspace(tabId, index + 1);
      return;
    }
    case "layout:fill":
      store.focusTab(tabId);
      store.toggleMaximizedTab(tabId);
      return;
    case "layout:copy-link": {
      const link = threadLinkFor(location.tab);
      if (!link) return;
      void writeTextToClipboard(link, "thread link").then(
        (copied) => {
          if (copied) toastManager.add({ type: "success", title: "Link copied" });
        },
        () => toastManager.add({ type: "error", title: "Could not copy the link" }),
      );
      return;
    }
    case "layout:close-tab":
      closeLayoutTabByUser(tabId);
      return;
    case "layout:close-other-tabs":
      closeOtherLayoutTabsByUser(tabId);
      return;
  }
}

type SurfaceTabMenuId = "rename" | "copy-path" | "toggle-mute";

/**
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
export function tabMuteMenuItem(input: {
  overlay: DesktopPreviewOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? "Unmute tab" : "Mute tab",
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

export function copyLayoutFilePath(threadRef: ScopedThreadRef, relativePath: string): void {
  const thread = readThreadShell(threadRef);
  const draft = useComposerDraftStore.getState().getDraftThreadByRef(threadRef);
  const projectId =
    thread?.projectId ??
    draft?.projectId ??
    threadlessSurfacesProjectRef(threadRef)?.projectId ??
    null;
  const project =
    projectId === null ? null : readProject(scopeProjectRef(threadRef.environmentId, projectId));
  const worktreePath = thread?.worktreePath ?? draft?.worktreePath ?? null;
  const home = readThreadlessHome(threadRef);
  const cwd = project
    ? projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath })
    : (home ?? worktreePath);
  void navigator.clipboard?.writeText(
    formatFilePathForClipboard(relativePath, resolvePathLinkTarget(relativePath, cwd ?? "")),
  );
}

function surfaceTabMenu(tab: LayoutTab | undefined): {
  items: ContextMenuItem<SurfaceTabMenuId>[];
  run: (action: Exclude<SurfaceTabMenuId, "rename">) => void;
} {
  const items: ContextMenuItem<SurfaceTabMenuId>[] = [];
  if (tab?.content.kind !== "surface") return { items, run: () => undefined };
  const { threadRef, surfaceId } = tab.content;
  const surface = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).surfaces.find((candidate) => candidate.id === surfaceId);
  const previewState = readThreadPreviewState(threadRef);
  const previewTabId =
    surface?.kind === "preview" && surface.resourceId
      ? (previewState.sessions[surface.resourceId]?.tabId ?? null)
      : null;
  const overlay = previewTabId ? (previewState.desktopByTabId[previewTabId] ?? null) : null;
  if (surface?.kind === "device") items.push({ id: "rename", label: "Rename" });
  if (surface?.kind === "file" && surface.attachment === undefined) {
    items.push({ id: "copy-path", label: "Copy path" });
  }
  if (surface?.kind === "preview") {
    items.push({
      id: "toggle-mute",
      ...tabMuteMenuItem({ overlay, canResolveRuntimeTabId: true }),
    });
  }
  return {
    items,
    run: (action) => {
      if (action === "copy-path" && surface?.kind === "file" && !surface.attachment) {
        copyLayoutFilePath(threadRef, surface.relativePath);
      } else if (action === "toggle-mute" && previewTabId && overlay) {
        void previewBridge
          ?.setAudioMuted(
            previewRuntimeTabId(threadRef, previewState.serverEpoch, previewTabId),
            !overlay.audioMuted,
          )
          .catch(() => undefined);
      }
    },
  };
}

/** Show a tab's menu at the pointer, its own actions before the layout's; resolves once it closes. */
export async function showLayoutTabMenu(
  tabId: string,
  position: { x: number; y: number },
  keybindings: ResolvedKeybindingsConfig,
  onRename: () => void = () => renameLayoutTab(tabId),
): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  const { layout } = useLayoutStore.getState();
  const layoutItems = buildLayoutTabMenuItems(layout, tabId, keybindings);
  if (layoutItems.length === 0) return;
  const own = surfaceTabMenu(findLayoutTab(layout, (tab) => tab.id === tabId)?.tab);
  const action = await api.contextMenu.show<SurfaceTabMenuId | LayoutTabMenuId>(
    [
      ...own.items,
      ...layoutItems.map((item, index) =>
        index === 0 && own.items.length > 0 ? { ...item, separatorBefore: true } : item,
      ),
    ],
    position,
  );
  if (action === null) return;
  if (isLayoutTabMenuId(action)) runLayoutTabMenuAction(action, tabId);
  else if (action === "rename") onRename();
  else own.run(action);
}

const useLayoutTabRenameStore = create<{ tabId: string | null }>(() => ({ tabId: null }));

function renameLayoutTab(tabId: string): void {
  useLayoutStore.getState().focusTab(tabId);
  useLayoutTabRenameStore.setState({ tabId });
}

export function useLayoutTabRenameRequested(tabId: string | null): boolean {
  return useLayoutTabRenameStore((state) => tabId !== null && state.tabId === tabId);
}

export function finishLayoutTabRename(tabId: string | null): void {
  if (tabId !== null && useLayoutTabRenameStore.getState().tabId === tabId) {
    useLayoutTabRenameStore.setState({ tabId: null });
  }
}

/** A middle click closes a tab, as in browsers and editors. */
export function closeLayoutTabOnMiddleClick(event: ReactMouseEvent, tabId: string): void {
  if (event.button !== 1) return;
  event.preventDefault();
  closeLayoutTabByUser(tabId);
}

/** Holds a notch tab and its close button. */
export const LAYOUT_TAB_SLOT_CLASS =
  "group/tab relative inline-flex max-w-full shrink-0 items-center hover:[--tab-icon-visibility:hidden] has-[[data-tab-close]:focus-visible]:[--tab-icon-visibility:hidden]";

/**
 * Wraps a notch tab's icon so the close button can take its place: the icon
 * hides while the tab is hovered or the button has keyboard focus. The slot sets the
 * variable; a `:has()` here, above the icon, would restyle every element
 * below each tab on any DOM change.
 */
export const LAYOUT_TAB_ICON_CLASS = "contents [visibility:var(--tab-icon-visibility)]";

/**
 * A notch tab's close button: a 12px x over the tab's icon, shown while the
 * pointer is on the tab or the button has keyboard focus. Render it after
 * the tab inside `LAYOUT_TAB_SLOT_CLASS`, with the tab's icon wrapped in
 * `LAYOUT_TAB_ICON_CLASS`.
 */
export function LayoutTabCloseButton({ tabId, title }: { tabId: string; title: string }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "tab.close");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContentButton
            variant="tab-close"
            type="button"
            aria-label={`Close ${title}`}
            className="absolute start-2.25 top-1/2 -translate-y-1/2"
            data-tab-close=""
            onClick={() => closeLayoutTabByUser(tabId)}
          />
        }
      >
        <XIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close tab{shortcut ? ` (${shortcut})` : ""}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A pane tab that is not the pane's active one (pen W6VyO): the same 28px
 * notch tab with its label in the muted tier. Click shows it, middle click
 * or its close button closes it, right click opens the tab's own menu without
 * showing it, dragging moves or splits it.
 */
export const LayoutPaneTab = memo(function LayoutPaneTab({ tab }: { tab: LayoutTab }) {
  if (tab.content.kind === "chat" && tab.content.target.kind === "server") {
    return <ThreadLayoutPaneTab tab={tab} threadRef={tab.content.target.threadRef} />;
  }
  return <PlainLayoutPaneTab tab={tab} />;
});

function PlainLayoutPaneTab({ tab }: { tab: LayoutTab }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return (
    <LayoutPaneTabButton
      tab={tab}
      onOpenMenu={(position) => void showLayoutTabMenu(tab.id, position, keybindings)}
    />
  );
}

function ThreadLayoutPaneTab({ tab, threadRef }: { tab: LayoutTab; threadRef: ScopedThreadRef }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(threadRef.environmentId));
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: project?.workspaceRoot ?? null,
    onStartRename: () => renameLayoutTab(tab.id),
    canShareWithGuest,
    leadingItems: () =>
      buildLayoutTabMenuItems(useLayoutStore.getState().layout, tab.id, keybindings),
    onLeadingAction: (id) => {
      if (isLayoutTabMenuId(id)) runLayoutTabMenuAction(id, tab.id);
    },
  });
  return <LayoutPaneTabButton tab={tab} onOpenMenu={openMenu} />;
}

function LayoutPaneTabButton({
  tab,
  onOpenMenu,
}: {
  tab: LayoutTab;
  onOpenMenu: (position: { x: number; y: number }) => void;
}) {
  const label = useLayoutTabLabel(tab);
  const focusTab = () => {
    useLayoutStore.getState().focusTab(tab.id);
  };
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenMenu({ x: event.clientX, y: event.clientY });
  };
  return (
    <span className={LAYOUT_TAB_SLOT_CLASS}>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContentButton
              variant="tab"
              type="button"
              data-layout-pane-tab={tab.id}
              onClick={focusTab}
              onDoubleClick={() => useLayoutStore.getState().keepTab(tab.id)}
              onAuxClick={(event) => closeLayoutTabOnMiddleClick(event, tab.id)}
              onPointerDown={(event) => beginLayoutTabDrag(event, tab.id)}
              onMouseDown={(event) => {
                // Keep the browser's middle-click autoscroll from starting.
                if (event.button === 1) event.preventDefault();
              }}
              onContextMenu={openMenu}
            />
          }
        >
          <span className={LAYOUT_TAB_ICON_CLASS}>{label.icon}</span>
          <span
            className={cn(
              PANE_INACTIVE_TAB_TITLE_CLASS,
              isLayoutGhostTab(tab) && PANE_GHOST_TAB_TITLE_CLASS,
            )}
            dir={textDirection(label.title)}
          >
            {label.title}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="whitespace-pre-line">
          {label.tooltip}
        </TooltipPopup>
      </Tooltip>
      <LayoutTabCloseButton tabId={tab.id} title={label.title} />
    </span>
  );
}

export function useLayoutTabLabel(tab: LayoutTab): {
  icon: React.ReactNode;
  title: string;
  tooltip: string;
} {
  const target = tab.content.kind === "chat" ? tab.content.target : null;
  const threadRef =
    target?.kind === "server"
      ? target.threadRef
      : tab.content.kind === "surface"
        ? tab.content.threadRef
        : null;
  const draftId = target?.kind === "draft" ? target.draftId : null;
  const thread = useQuietThreadShell(threadRef);
  const ghostParent = useQuietThreadShell(tab.ghostOf ?? null);
  const terminalRef =
    tab.content.kind === "surface" && tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID
      ? tab.content.threadRef
      : null;
  const terminalUi = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, terminalRef),
  );
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const surfaceDraft = useComposerDraftStore((store) =>
    tab.content.kind === "surface" ? store.getDraftThreadByRef(tab.content.threadRef) : null,
  );
  const surface = useRightPanelStore((state) =>
    tab.content.kind === "surface"
      ? (selectThreadRightPanelState(state.byThreadKey, tab.content.threadRef).surfaces.find(
          (candidate) => tab.content.kind === "surface" && candidate.id === tab.content.surfaceId,
        ) ?? null)
      : null,
  );
  const surfaceThreadRef = tab.content.kind === "surface" ? tab.content.threadRef : null;
  const sessionRef = terminalRef ?? (surface?.kind === "terminal" ? surfaceThreadRef : null);
  const terminalSessions = useKnownTerminalSessions({
    environmentId: sessionRef?.environmentId ?? null,
    threadId: sessionRef?.threadId ?? null,
  });
  const activeTerminalId =
    surface?.kind === "terminal" ? surface.activeTerminalId : terminalUi.activeTerminalId;
  const terminal = terminalSessions?.find(
    (session) => session.target.terminalId === activeTerminalId,
  );
  const terminalRunning = terminalSessions?.some(
    (session) =>
      (surface?.kind === "terminal" ? surface.terminalIds : terminalUi.terminalIds).includes(
        session.target.terminalId,
      ) && session.state.hasRunningSubprocess,
  );
  const previewState = useThreadPreviewState(surface?.kind === "preview" ? surfaceThreadRef : null);
  const preview =
    surface?.kind === "preview" && surface.resourceId
      ? previewState.sessions[surface.resourceId]
      : null;
  const sideChat = useQuietThreadShell(
    surface?.kind === "side-chat" && surfaceThreadRef
      ? scopeThreadRef(surfaceThreadRef.environmentId, surface.threadId)
      : null,
  );
  const threadless = isThreadlessSurfacesRef(surfaceThreadRef);
  const home = useThreadlessHome(surfaceThreadRef);
  const projectRef = (() => {
    if (thread) return scopeProjectRef(thread.environmentId, thread.projectId);
    if (draftSession) return scopeProjectRef(draftSession.environmentId, draftSession.projectId);
    if (surfaceDraft) return scopeProjectRef(surfaceDraft.environmentId, surfaceDraft.projectId);
    return threadlessSurfacesProjectRef(surfaceThreadRef);
  })();
  const project = useProject(projectRef);
  if (isLayoutPageContent(tab.content)) {
    const title =
      tab.content.kind === "settings"
        ? "Settings"
        : tab.content.kind === "usage"
          ? "Usage"
          : "Pull requests";
    const Icon =
      tab.content.kind === "settings"
        ? SettingsIcon
        : tab.content.kind === "usage"
          ? ChartNoAxesColumnIcon
          : PullRequestGlyph.pullRequest;
    return {
      icon: <Icon aria-hidden className="size-3.5 shrink-0" />,
      title,
      tooltip: title,
    };
  }
  if (tab.content.kind === "launcher") {
    return {
      icon: <SquareDashedIcon aria-hidden className="size-3.5 shrink-0" />,
      title: "New tab",
      tooltip: "New tab",
    };
  }
  if (tab.content.kind === "surface") {
    // The resource owns the title. Its thread, location and state belong in the tooltip.
    const threadTerminal = tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID;
    const threadTitle =
      thread?.title ??
      (surfaceDraft ? "New thread" : null) ??
      (threadless
        ? (project?.title ??
          (isThreadlessHomeRef(surfaceThreadRef) &&
          surface?.kind !== "preview" &&
          surface?.kind !== "device"
            ? "~"
            : null))
        : null);
    const title = surface
      ? (sideChat?.title ?? surfaceTabTitle(surface, preview, terminal?.state.summary?.label))
      : terminalRef
        ? terminalTabTitle(activeTerminalId, terminal?.state.summary?.label)
        : "Surface";
    const root =
      thread?.worktreePath ?? surfaceDraft?.worktreePath ?? project?.workspaceRoot ?? home;
    const path =
      surface?.kind === "file"
        ? resolvePathLinkTarget(surface.relativePath, root ?? "")
        : surface?.kind === "files"
          ? root
          : terminal?.state.summary?.cwd;
    const url =
      preview?.navStatus && preview.navStatus._tag !== "Idle"
        ? preview.navStatus.url
        : surface?.kind === "preview" && surface.resourceId
          ? surface.url
          : surface?.kind === "pull-request"
            ? surface.url
            : null;
    const status =
      terminalRef || surface?.kind === "terminal"
        ? terminalRunning
          ? "Process running"
          : terminal && resolveTerminalActivityStatus(terminal.state) === "failed"
            ? "Last command failed"
            : "Idle"
        : null;
    return {
      icon: threadTerminal ? (
        <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
      ) : surface ? (
        <ThreadSurfaceTabIcon threadRef={tab.content.threadRef} surface={surface} />
      ) : (
        <PanelRightIcon aria-hidden className="size-3.5 shrink-0" />
      ),
      title,
      tooltip: [
        title,
        terminal?.state.summary?.label,
        surface?.kind === "preview" && title !== "Browser" ? "Browser" : null,
        threadTitle,
        path,
        url,
        status,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  const title = thread?.title ?? "New thread";
  if (tab.ghostOf) {
    return {
      icon: <GitForkIcon aria-hidden className="size-3.5 shrink-0" />,
      title,
      tooltip: ghostTabTooltip(title, ghostParent?.title),
    };
  }
  const icon =
    draftId !== null ? (
      <SquarePenIcon aria-hidden className="size-3.5 shrink-0" />
    ) : project ? (
      <ProjectFavicon project={project} className="size-3.5 shrink-0" />
    ) : null;
  const tooltip = project ? `${project.title} / ${title}` : title;
  return {
    icon,
    title,
    tooltip: isLayoutGhostTab(tab) ? ghostTabTooltip(tooltip, undefined) : tooltip,
  };
}

/** A ghost tab names the thread it was opened from, if any, and how to keep it. */
export function ghostTabTooltip(title: string, parentTitle: string | undefined): string {
  return [title, parentTitle ? `Opened from ${parentTitle}` : null, "Double-click to keep open"]
    .filter(Boolean)
    .join("\n");
}

/** The thread a lineage ghost tab was opened from (`LayoutTab.ghostOf`), or null. */
export function useLayoutTabGhostOf(tabId: string | null) {
  return useLayoutStore((state) =>
    tabId === null
      ? null
      : (findLayoutTab(state.layout, (tab) => tab.id === tabId)?.tab.ghostOf ?? null),
  );
}

/** The tab draws as a ghost: italic, kept by a double-click (see `isLayoutGhostTabShown`). */
export function useLayoutTabGhostShown(tabId: string | null): boolean {
  return useLayoutStore((state) =>
    tabId === null ? false : isLayoutGhostTabShown(state.layout, tabId),
  );
}
