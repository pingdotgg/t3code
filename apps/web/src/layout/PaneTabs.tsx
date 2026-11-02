import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  ContextMenuItem,
  KeybindingCommand,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  ChartNoAxesColumnIcon,
  FileDiff,
  Files,
  Globe2,
  PanelRightIcon,
  SettingsIcon,
  Smartphone,
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
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import {
  isThreadlessHomeRef,
  isThreadlessSurfacesRef,
  threadlessSurfacesProjectRef,
} from "../threadlessSurfaces";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { ContentButton } from "../components/ui/button";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";
import { contextMenuShortcutFields, shortcutLabelForCommand } from "../keybindings";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { textDirection } from "../textDirection";
import { buildThreadRouteParams } from "../threadRoutes";
import { toastManager } from "../components/ui/toast";
import { useProject, useQuietThreadShell } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  countLayoutTabs,
  findLayoutPane,
  findLayoutTab,
  isLayoutPageContent,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutState,
  type LayoutTab,
} from "./layoutModel";
import { closeLayoutTabByUser, closeOtherLayoutTabsByUser, splitLayoutTab } from "./layoutActions";
import { beginLayoutTabDrag } from "./layoutDrag";
import { useLayoutPane } from "./layoutPaneContext";
import { useLayoutStore } from "./layoutStore";
import { setWheelScroller, wheelDeltaPx } from "../motion/gesture";
import { observeResize } from "../lib/observeResize";

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
  if (countLayoutTabs(layout) > 1) {
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
    // A user closing a thread settles it (subscribeLayoutThreadsClosedByUser).
    case "layout:close-tab":
      closeLayoutTabByUser(tabId);
      return;
    case "layout:close-other-tabs":
      closeOtherLayoutTabsByUser(tabId);
      return;
  }
}

/** Show the layout menu for a tab at the pointer; resolves once it closes. */
export async function showLayoutTabMenu(
  tabId: string,
  position: { x: number; y: number },
  keybindings: ResolvedKeybindingsConfig,
): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  const items = buildLayoutTabMenuItems(useLayoutStore.getState().layout, tabId, keybindings);
  if (items.length === 0) return;
  const action = await api.contextMenu.show(items, position);
  if (action) runLayoutTabMenuAction(action, tabId);
}

/** A middle click closes a tab, as in browsers and editors. */
export function closeLayoutTabOnMiddleClick(event: ReactMouseEvent, tabId: string): void {
  if (event.button !== 1) return;
  event.preventDefault();
  closeLayoutTabByUser(tabId);
}

/**
 * Holds a notch tab and its close button. The other tabs add `shrink-[2]`,
 * so when the notch runs out of room the tab on screen keeps its title
 * longest.
 */
export const LAYOUT_TAB_SLOT_CLASS =
  "group/tab relative inline-flex min-w-0 items-center has-[[data-tab-close]:hover,[data-tab-close]:focus-visible]:[--tab-icon-visibility:hidden]";

/**
 * Wraps a notch tab's icon so the close button can take its place: the icon
 * hides while the button over it is hovered or focused. The slot sets the
 * variable; a `:has()` here, above the icon, would restyle every element
 * below each tab on any DOM change.
 */
export const LAYOUT_TAB_ICON_CLASS = "contents [visibility:var(--tab-icon-visibility)]";

/**
 * A notch tab's close button: a 12px x over the tab's icon, shown while the
 * pointer is on the icon or the button has keyboard focus. Render it after
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
 * or its close button closes it, right click opens the layout menu, dragging
 * moves or splits it.
 */
export const LayoutPaneTab = memo(function LayoutPaneTab({ tab }: { tab: LayoutTab }) {
  const label = useLayoutTabLabel(tab);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const focusTab = () => {
    useLayoutStore.getState().focusTab(tab.id);
  };
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void showLayoutTabMenu(tab.id, { x: event.clientX, y: event.clientY }, keybindings);
  };
  return (
    // Clipped to its box, so a squeezed tab never slides under its neighbor;
    // it keeps at least its icon, so a Settings or side tab stays findable.
    <span className={cn(LAYOUT_TAB_SLOT_CLASS, "min-w-8.5 shrink-[2] overflow-hidden")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContentButton
              variant="tab"
              type="button"
              data-layout-pane-tab={tab.id}
              onClick={focusTab}
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
          <span className="min-w-[4ch] truncate" dir={textDirection(label.title)}>
            {label.title}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label.tooltip}</TooltipPopup>
      </Tooltip>
      <LayoutTabCloseButton tabId={tab.id} title={label.title} />
    </span>
  );
});

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
  const threadless = isThreadlessSurfacesRef(surfaceThreadRef);
  const projectRef = (() => {
    if (thread) return scopeProjectRef(thread.environmentId, thread.projectId);
    if (draftSession) return scopeProjectRef(draftSession.environmentId, draftSession.projectId);
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
    // A surface names what it is and the thread it works in: "Diff · Fix login",
    // or threadless, its project: "Terminal 1 · t3code", or the home folder
    // a project-less one's terminal, files and diff work in: "Files · ~".
    const { label, Icon } =
      tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID
        ? { label: "Terminal", Icon: SquareTerminal }
        : layoutSurfaceLabel(surface);
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
    const title = threadTitle ? `${label} · ${threadTitle}` : label;
    return { icon: <Icon aria-hidden className="size-3.5 shrink-0" />, title, tooltip: title };
  }
  const title = thread?.title ?? "New thread";
  const icon =
    draftId !== null ? (
      <SquarePenIcon aria-hidden className="size-3.5 shrink-0" />
    ) : project ? (
      <ProjectFavicon project={project} className="size-3.5 shrink-0" />
    ) : null;
  return { icon, title, tooltip: project ? `${project.title} / ${title}` : title };
}

/** A surface's short name and icon for its tab. */
function layoutSurfaceLabel(surface: RightPanelSurface | null): {
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
} {
  switch (surface?.kind) {
    case "diff":
      return { label: "Diff", Icon: FileDiff };
    case "files":
      return { label: "Files", Icon: Files };
    case "file":
      return {
        label: surface.relativePath.slice(
          Math.max(surface.relativePath.lastIndexOf("/"), surface.relativePath.lastIndexOf("\\")) +
            1,
        ),
        Icon: Files,
      };
    case "terminal":
      // Numbered, unlike the thread's own terminal (cmd+J), which is just "Terminal".
      return { label: getTerminalLabel(surface.activeTerminalId), Icon: SquareTerminal };
    case "pull-request":
      return { label: `#${surface.number}`, Icon: PullRequestGlyph.pullRequest };
    case "pull-requests":
      return { label: "Pull requests", Icon: PullRequestGlyph.link };
    case "device":
      return { label: surface.title ?? surface.target?.name ?? "Device", Icon: Smartphone };
    case "preview":
      return { label: "Browser", Icon: Globe2 };
    default:
      return { label: "Surface", Icon: PanelRightIcon };
  }
}
