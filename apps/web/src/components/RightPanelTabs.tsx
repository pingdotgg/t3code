import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useQuietThreadShell } from "~/state/entities";
import { useLayoutPane, useLayoutPaneFocusedRef } from "../layout/layoutPaneContext";
import { beginLayoutTabDrag } from "../layout/layoutDrag";
import { useLayoutStore } from "../layout/layoutStore";
import {
  buildLayoutTabMenuItems,
  isLayoutTabMenuId,
  LayoutPaneTab,
  LayoutPaneTabStrip,
  runLayoutTabMenuAction,
  useLayoutPaneSiblingTabs,
  useLayoutTabLabel,
} from "../layout/PaneTabs";
import { findLayoutTab, type LayoutTab } from "../layout/layoutModel";
import type {
  ContextMenuItem,
  EnvironmentId,
  PreviewSessionSnapshot,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronLeft, ChevronRight, Files, Plus } from "lucide-react";
import { Volume2, VolumeOff } from "lucide";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "~/components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { ScrollArea } from "~/components/ui/scroll-area";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { useTheme } from "~/hooks/useTheme";
import { useDeviceState } from "~/state/device";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { useRevealActiveTab } from "~/hooks/useRevealActiveTab";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PanelTabSlotsContext, usePanelTabActionsHost } from "./PanelTabBreadcrumb";
import {
  PANE_BODY_UNDER_HEADER_CLASS,
  PANE_INACTIVE_TAB_TITLE_CLASS,
  PANE_TAB_TITLE_CLASS,
  PaneNotch,
} from "./PaneNotch";
import { previewBridge } from "./preview/previewBridge";
import { observeResize } from "~/lib/observeResize";
import {
  previewFaviconOf,
  SurfaceIcon,
  surfaceTitle,
  type PullRequestTabStatusSeed,
} from "./SurfaceTabIcon";
import {
  SurfaceLauncherRows,
  SurfaceMenuItems,
  surfaceMenuActions,
  surfaceShortcutActionForKey,
  useLauncherElement,
  useSurfaceLauncherKeys,
  type SurfaceLauncherAction,
} from "./SurfaceLauncher";

export {
  surfaceShortcutActionForKey,
  surfaceShortcutTargetsTypingContext,
} from "./SurfaceLauncher";

export interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  keybindings: ResolvedKeybindingsConfig;
  widthStorageKey?: string;
  defaultWidth?: number;
  /**
   * An inline panel drawn as its own inset pane, notch and all, beside a page's pane (the
   * pull requests page's review, pen bETcv).
   */
  pane?: boolean;
  inlineSize?: PreviewPanelInlineSize;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  environmentId: EnvironmentId | null;
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  /** Maps server-local session ids to desktop runtime ids; session ids cannot address desktop operations. */
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onRenameDevice?: (surfaceId: string, title: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onMoveSurface?: (surfaceId: string, toIndex: number) => void;
  onCopyFilePath: (relativePath: string) => void;
  /** Escape on the empty pane's chooser closes the pane; the sheet closes itself. */
  onClose?: () => void;
  onAddBrowser: () => void;
  /** Keep separate from the DOM click handler so a MouseEvent cannot become a profile id. */
  onAddBrowserInProfile: (profileId: string) => void;
  /** The "+" menu's New thread, in the thread's project; omitted, it has none. */
  onNewThread?: (() => void) | undefined;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddDevice: () => void;
  /** Absent where side chats are not offered. */
  onAddSideChat?: (() => void) | undefined;
  browserAvailable: boolean;
  /** Why the browser cannot open, when it cannot. */
  browserUnavailableReason?: string | null;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  deviceAvailable: boolean;
  sideChatAvailable?: boolean;
  /** Overrides the default reason while side chats are available but cannot start. */
  sideChatDisabledReason?: string | null;
  pullRequestStatusSeeds?: Readonly<Record<string, PullRequestTabStatusSeed>>;
  /** The linked thread stays in the tab's tooltip when its surface moves elsewhere. */
  threadTitle?: string | null;
  children: ReactNode;
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the T3 Code desktop app.",
  terminal: "Terminal surfaces are only available from a project thread.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  pullRequests: "No linked pull requests are available for this thread.",
  device: "Devices are only available from a thread.",
  sideChat: "Side chats start after the first message.",
} as const;

type TabContextMenuAction =
  | "rename"
  | "copy-path"
  | "toggle-mute"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

const TAB_SCROLL_EDGE_TOLERANCE = 1;
const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

function tabScrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

function previewTabIdOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string | null {
  if (surface.kind !== "preview" || !surface.resourceId) return null;
  return sessions[surface.resourceId]?.tabId ?? null;
}

/**
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
function tabMuteMenuItem(input: {
  overlay: DesktopPreviewOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? "Unmute tab" : "Mute tab",
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

type TabAudioState = "none" | "audible" | "muted";

function tabAudioState(overlay: DesktopPreviewOverlay | null): TabAudioState {
  if (!overlay?.audible) return "none";
  return overlay.audioMuted ? "muted" : "audible";
}

/**
 * A layout pane's tabs sit in its notch with "+" as the notch's last child,
 * like a chat's and the terminal's; the sheet and inline panel keep a plain row.
 */
function PanelTabStrip({
  notched,
  ref,
  children,
}: {
  notched: boolean;
  ref: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  if (notched) {
    return (
      <div ref={ref} className="flex shrink-0 items-center gap-1" data-right-panel-tab-list>
        {children}
      </div>
    );
  }
  return (
    <ScrollArea
      radius="none"
      ref={ref}
      hideScrollbars
      scrollFade
      className="min-w-0 flex-1"
      data-right-panel-tab-list
    >
      <div className="flex h-full w-max min-w-full items-center gap-1">{children}</div>
    </ScrollArea>
  );
}

function PanelTabsNotch(props: { notched: boolean; addButton: ReactNode; children: ReactNode }) {
  if (!props.notched) return props.children;
  return (
    <PaneNotch>
      <LayoutPaneTabStrip>{props.children}</LayoutPaneTabStrip>
      {props.addButton ? (
        <span data-pane-notch-add="" className="flex shrink-0">
          {props.addButton}
        </span>
      ) : null}
    </PaneNotch>
  );
}

function PanelActionsNotch(props: { notched: boolean; hasActions: boolean; children: ReactNode }) {
  if (!props.notched) return props.children;
  if (!props.hasActions) return null;
  return (
    <PaneNotch side="right" className="ms-auto shrink-0">
      {props.children}
    </PaneNotch>
  );
}

/**
 * Pane-wide letter shortcuts must yield to typing contexts.
 * The focused launcher also supports arrows and explains unavailable surfaces.
 */
function RightPanelEmptyState(props: {
  onClose: (() => void) | undefined;
  onAddBrowser: () => void;
  onAddBrowserInProfile: (profileId: string) => void;
  browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddDevice: () => void;
  /** Absent where side chats are not offered. */
  onAddSideChat?: (() => void) | undefined;
  browserAvailable: boolean;
  browserUnavailableReason: string | null | undefined;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  deviceAvailable: boolean;
  sideChatAvailable: boolean;
  sideChatDisabledReason: string | null;
}) {
  const actions: SurfaceLauncherAction[] = [
    {
      kind: "browser",
      shortcut: "B",
      available: props.browserAvailable,
      ...(props.browserUnavailableReason ? { disabledReason: props.browserUnavailableReason } : {}),
      onClick: props.onAddBrowser,
    },
    {
      kind: "terminal",
      shortcut: "T",
      available: props.terminalAvailable,
      onClick: props.onAddTerminal,
    },
    { kind: "files", shortcut: "F", available: props.filesAvailable, onClick: props.onAddFiles },
    { kind: "diff", shortcut: "D", available: props.diffAvailable, onClick: props.onAddDiff },
    {
      kind: "pull-request",
      shortcut: "P",
      available: props.pullRequestAvailable,
      onClick: props.onAddPullRequest,
    },
    {
      kind: "pull-requests",
      shortcut: "L",
      available: props.pullRequestsAvailable,
      onClick: props.onAddPullRequests,
    },
    { kind: "device", shortcut: "M", available: props.deviceAvailable, onClick: props.onAddDevice },
    ...(props.onAddSideChat
      ? [
          {
            kind: "side-chat" as const,
            shortcut: "S",
            available: props.sideChatAvailable && !props.sideChatDisabledReason,
            onClick: props.onAddSideChat,
          },
        ]
      : []),
  ];
  const paneFocusedRef = useLayoutPaneFocusedRef();
  const [launcherRef, attachLauncher] = useLauncherElement(paneFocusedRef, false);
  useSurfaceLauncherKeys({
    launcherRef,
    activeRef: paneFocusedRef,
    actions,
    onClose: props.onClose,
  });

  return (
    <div
      data-workspace-focus-default
      ref={attachLauncher}
      tabIndex={0}
      aria-label="Open a surface"
      data-surface-launcher-keys={actions
        .filter((action) => action.available)
        .map((action) => action.shortcut)
        .join("")}
      className={cn(
        "scrollbar-gutter-both flex min-h-0 flex-1 items-center-safe justify-center overflow-y-auto px-4 outline-none",
        "pb-(--workspace-topbar-height)",
      )}
    >
      <div
        role="list"
        aria-label="Surfaces"
        className="flex w-full max-w-110 flex-col gap-0.5 py-6"
      >
        <SurfaceLauncherRows
          actions={actions}
          browserProfiles={props.browserProfiles}
          onAddBrowserInProfile={props.onAddBrowserInProfile}
        />
      </div>
    </div>
  );
}

function SortableTabList(props: {
  surfaces: readonly RightPanelSurface[];
  onMove: ((surfaceId: string, toIndex: number) => void) | undefined;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const surfaceIds = props.surfaces.map((surface) => surface.id);
  const { onMove, surfaces } = props;
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = surfaces.findIndex((surface) => surface.id === over.id);
    if (toIndex >= 0) onMove?.(String(active.id), toIndex);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={TAB_DRAG_MODIFIERS}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={surfaceIds} strategy={horizontalListSortingStrategy}>
        {props.children}
      </SortableContext>
    </DndContext>
  );
}

interface RightPanelTabHandlers {
  onActivate: (surface: RightPanelSurface) => void;
  onClose: (surface: RightPanelSurface) => void;
  onAuxClick: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onContextMenu: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onStartRename: (surfaceId: string) => void;
  onFinishRename: (surfaceId: string, title: string) => void;
}

const NO_LAYOUT_TAB: LayoutTab = {
  id: "panel",
  content: { kind: "launcher", id: "panel", context: null },
};

// Chromium on Linux only suppresses primary-selection paste when mouseup is cancelled.
function preventTabMiddleButtonDefault(event: ReactMouseEvent) {
  if (event.button !== 1) return;
  event.preventDefault();
}

// Stable handlers and per-tab values let the compiler reuse tabs across parent renders.
function RightPanelTab(
  props: RightPanelTabHandlers & {
    surface: RightPanelSurface;
    dragDisabled: boolean;
    active: boolean;
    pending: boolean;
    title: string;
    audio: TabAudioState;
    audioRuntimeTabId: string | null;
    previewUrl: string | null;
    previewCapturedUrl: string | null;
    theme: "light" | "dark";
    environmentId: EnvironmentId | null;
    pullRequestStatusSeed: PullRequestTabStatusSeed | undefined;
    renaming: boolean;
    canRename: boolean;
    ownsDesktopTitleBar: boolean;
    notched: boolean;
    layoutTabId: string | null;
    threadTitle: string | null;
    onBreadcrumbSlotChange: (element: HTMLSpanElement | null) => void;
  },
) {
  const {
    dragDisabled,
    previewUrl,
    previewCapturedUrl,
    theme,
    environmentId,
    pullRequestStatusSeed,
    renaming,
    canRename,
    threadTitle,
    onBreadcrumbSlotChange,
    surface,
    audio,
    audioRuntimeTabId,
    active,
    pending,
    notched,
    layoutTabId,
    ownsDesktopTitleBar,
    onActivate,
    onClose,
    onAuxClick,
    onContextMenu,
    onStartRename,
    onFinishRename,
  } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
    disabled: dragDisabled,
  });
  const sideChatShell = useQuietThreadShell(
    surface.kind === "side-chat" && props.environmentId !== null
      ? scopeThreadRef(props.environmentId, surface.threadId)
      : null,
  );
  const layoutTab = useLayoutStore((state) =>
    layoutTabId === null
      ? null
      : (findLayoutTab(state.layout, (tab) => tab.id === layoutTabId)?.tab ?? null),
  );
  const layoutLabel = useLayoutTabLabel(layoutTab ?? NO_LAYOUT_TAB);
  const title = layoutTab ? layoutLabel.title : (sideChatShell?.title ?? props.title);
  const tooltip = layoutTab
    ? layoutLabel.tooltip
    : [title, threadTitle, previewUrl, surface.kind === "file" ? surface.relativePath : null]
        .filter(Boolean)
        .join("\n");
  // An open workspace file reads "Files › file.tsx": its breadcrumb names it.
  const filesCrumb = active && surface.kind === "file" && !surface.attachment;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-active-tab={active}
      data-tab-key={surface.id}
      data-layout-pane-tab={layoutTabId ?? undefined}
      data-layout-tab-reveal={filesCrumb ? "end" : undefined}
      onPointerDown={
        layoutTabId !== null ? (event) => beginLayoutTabDrag(event, layoutTabId) : undefined
      }
      onMouseDown={preventTabMiddleButtonDefault}
      onMouseUp={preventTabMiddleButtonDefault}
      onAuxClick={(event) => onAuxClick(event, surface)}
      onContextMenu={(event) => onContextMenu(event, surface)}
      {...listeners}
      className={cn(
        "cursor-pointer group/tab flex shrink-0 items-center",
        isDragging && "relative z-10",
        // In the notch a tab is the chat's 28px notch tab (pen JiaZk).
        notched
          ? "h-7 gap-1.75 rounded-control px-2.5 text-label"
          : "h-6 gap-0.5 rounded-item pr-2 pl-1.5 text-xs",
        // The active tab grows with its breadcrumb; its title caps below.
        !active && !notched && "max-w-36",
        ownsDesktopTitleBar && "[-webkit-app-region:no-drag]",
        active
          ? cn("text-strong-foreground", !notched && "font-medium")
          : "text-muted-foreground hover:surface-ghost-hover hover:text-foreground",
      )}
    >
      <>
        <PanelTabCloseButton label={`Close ${title}`} onClick={() => onClose(surface)}>
          {filesCrumb ? (
            <Files className="size-3.5 shrink-0 text-foreground" />
          ) : surface.kind === "terminal" && layoutTab ? (
            layoutLabel.icon
          ) : (
            <SurfaceIcon
              surface={surface}
              previewUrl={previewUrl}
              previewCapturedUrl={previewCapturedUrl}
              theme={theme}
              environmentId={environmentId}
              pullRequestStatusSeed={pullRequestStatusSeed}
            />
          )}
          {pending ? (
            <span
              className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
              aria-hidden
            />
          ) : null}
        </PanelTabCloseButton>
        {audio === "none" || !audioRuntimeTabId ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="cursor-pointer flex size-4 shrink-0 items-center justify-center rounded-kbd hover:surface-ghost-hover"
                  aria-label={audio === "muted" ? `Unmute ${title}` : `Mute ${title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void previewBridge
                      ?.setAudioMuted(audioRuntimeTabId, audio !== "muted")
                      .catch(() => undefined);
                  }}
                >
                  <MorphIcon className="size-3" icon={audio === "muted" ? VolumeOff : Volume2} />
                </button>
              }
            />
            <TooltipPopup>{audio === "muted" ? "Unmute tab" : "Mute tab"}</TooltipPopup>
          </Tooltip>
        )}
        {renaming ? (
          <input
            aria-label="Device tab name"
            className="w-24 min-w-0 rounded-kbd surface-well px-1 outline-none focus:surface-focus"
            defaultValue={title}
            ref={(element) => {
              element?.focus();
              element?.select();
            }}
            onBlur={(event) => onFinishRename(surface.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = title;
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onDoubleClick={() => {
                    if (surface.kind === "device" && canRename) onStartRename(surface.id);
                  }}
                  className={cn(
                    "cursor-pointer flex min-w-0 items-center",
                    active && surface.kind === "diff" && "shrink-0",
                  )}
                  aria-label={
                    surface.kind === "terminal" && threadTitle
                      ? `${title}, ${threadTitle}`
                      : undefined
                  }
                  onClick={() => onActivate(surface)}
                >
                  <span
                    className={
                      notched
                        ? active
                          ? PANE_TAB_TITLE_CLASS
                          : PANE_INACTIVE_TAB_TITLE_CLASS
                        : cn("truncate", active && "max-w-60")
                    }
                  >
                    {filesCrumb ? "Files" : title}
                  </span>
                </button>
              }
            />
            <TooltipPopup className="whitespace-pre-line">
              {surface.kind === "device" ? (
                <>
                  {threadTitle ? (
                    <>
                      {threadTitle}
                      <br />
                    </>
                  ) : null}
                  <DeviceTabTooltip surface={surface} environmentId={environmentId} title={title} />
                </>
              ) : (
                tooltip
              )}
            </TooltipPopup>
          </Tooltip>
        )}
        {active ? (
          <span
            ref={onBreadcrumbSlotChange}
            className={cn(
              "flex min-w-0 items-center empty:hidden",
              filesCrumb && "min-w-[8ch]",
              notched ? "gap-1" : "gap-0.5",
            )}
          />
        ) : null}
      </>
    </div>
  );
}

const PANE_BODY_SURFACE_CLASS: Partial<Record<RightPanelSurface["kind"], string>> = {
  "pull-request": "bg-(--code-surface)",
  "pull-requests": "bg-transparent",
  file: "bg-(--code-surface)",
  terminal: "bg-(--terminal-background)",
};

export function RightPanelTabs(props: RightPanelTabsProps) {
  const focusedSurface = props.surfaces.find((surface) => surface.id === props.activeSurfaceId);
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const browserProfiles = useBrowserDefaults().profiles;
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  // Embedded, this is one surface's tab in the layout: it drags like any tab
  // and its pane's other tabs sit around it in the notch.
  const { tabId: layoutPaneTabId, leadingEdge } = useLayoutPane();
  const layoutTabId = props.mode === "embedded" ? layoutPaneTabId : null;
  const siblingTabs = useLayoutPaneSiblingTabs();
  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);
  // The active tab's breadcrumb and the row's actions slot; its surface
  // portals its header into them (PanelTabBreadcrumb, PanelTabActions).
  const [breadcrumbSlot, setBreadcrumbSlot] = useState<HTMLSpanElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const { hasActions, registerActions } = usePanelTabActionsHost();
  const tabSlots = { breadcrumb: breadcrumbSlot, actions: actionsSlot, registerActions };
  // A layout pane's tabs sit in its notch (pen JiaZk), like a chat's.
  const notched = props.mode === "embedded" || props.pane === true;
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });

  if (props.open === false && addSurfaceMenuOpen) setAddSurfaceMenuOpen(false);

  const updateTabScrollState = (viewport: HTMLDivElement) => {
    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollLeft = hasOverflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE;
    setTabScrollState((current) => {
      if (
        current.hasOverflow === hasOverflow &&
        current.canScrollLeft === canScrollLeft &&
        current.canScrollRight === canScrollRight
      ) {
        return current;
      }
      return { hasOverflow, canScrollLeft, canScrollRight };
    });
  };

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const addSurfaceActions = surfaceMenuActions({
    onNewThread: props.onNewThread,
    surfaces: {
      browser: {
        available: props.browserAvailable,
        disabledReason: props.browserUnavailableReason ?? SURFACE_DISABLED_REASONS.browser,
        onClick: props.onAddBrowser,
      },
      terminal: {
        available: props.terminalAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.terminal,
        onClick: props.onAddTerminal,
      },
      files: {
        available: props.filesAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.files,
        onClick: props.onAddFiles,
      },
      diff: {
        available: props.diffAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.diff,
        onClick: props.onAddDiff,
      },
      "pull-request": {
        available: props.pullRequestAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.pullRequest,
        onClick: props.onAddPullRequest,
      },
      "pull-requests": {
        available: props.pullRequestsAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.pullRequests,
        onClick: props.onAddPullRequests,
      },
      device: {
        available: props.deviceAvailable,
        disabledReason: SURFACE_DISABLED_REASONS.device,
        onClick: props.onAddDevice,
      },
      ...(props.onAddSideChat
        ? {
            "side-chat": {
              available: props.sideChatAvailable === true && !props.sideChatDisabledReason,
              disabledReason: props.sideChatDisabledReason ?? SURFACE_DISABLED_REASONS.sideChat,
              onClick: props.onAddSideChat,
            },
          }
        : {}),
    },
  });

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(addSurfaceActions, event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setAddSurfaceMenuOpen(false);
    action.onClick();
  };

  const handleTabContextMenu = async (event: ReactMouseEvent, surface: RightPanelSurface) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) return;

    const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;

    const items: ContextMenuItem<TabContextMenuAction>[] = [];
    if (surface.kind === "device" && props.onRenameDevice)
      items.push({ id: "rename", label: "Rename" });
    if (surface.kind === "file" && surface.attachment === undefined) {
      items.push({ id: "copy-path", label: "Copy path" });
    }
    const menuPreviewTabId = previewTabIdOf(surface, props.previewSessions);
    const menuOverlay = menuPreviewTabId ? (props.desktopByTabId[menuPreviewTabId] ?? null) : null;
    const menuMuted = menuOverlay?.audioMuted ?? false;
    if (surface.kind === "preview") {
      items.push({
        id: "toggle-mute",
        ...tabMuteMenuItem({
          overlay: menuOverlay,
          canResolveRuntimeTabId: props.previewRuntimeTabId !== undefined,
        }),
      });
    }
    // A surface tab in the layout offers the layout's tab actions after its own.
    if (layoutTabId !== null) {
      const keybindings = props.keybindings;
      const layoutItems = buildLayoutTabMenuItems(
        useLayoutStore.getState().layout,
        layoutTabId,
        keybindings,
      ).map((item, index) =>
        index === 0 && items.length > 0 ? { ...item, separatorBefore: true } : item,
      );
      const picked = await api.contextMenu.show<
        TabContextMenuAction | (typeof layoutItems)[number]["id"]
      >([...items, ...layoutItems], { x: event.clientX, y: event.clientY });
      if (picked !== null && isLayoutTabMenuId(picked)) {
        runLayoutTabMenuAction(picked, layoutTabId);
        return;
      }
      if (picked === "rename") setRenamingDevice(surface.id);
      else if (picked === "copy-path" && surface.kind === "file" && !surface.attachment) {
        props.onCopyFilePath(surface.relativePath);
      } else if (picked === "toggle-mute") {
        const runtimeTabId =
          menuPreviewTabId && menuOverlay
            ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
            : null;
        if (runtimeTabId) {
          void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined);
        }
      }
      return;
    }
    items.push(
      { id: "close", label: "Close" },
      {
        id: "close-others",
        label: "Close others",
        disabled: props.surfaces.length <= 1,
      },
      {
        id: "close-to-right",
        label: "Close to the right",
        disabled: surfaceIndex >= props.surfaces.length - 1,
      },
      {
        id: "close-all",
        label: "Close all",
        disabled: props.surfaces.length === 0,
      },
    );

    const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    switch (action) {
      case "rename":
        setRenamingDevice(surface.id);
        break;
      case "copy-path":
        if (surface.kind === "file" && surface.attachment === undefined) {
          props.onCopyFilePath(surface.relativePath);
        }
        break;
      case "toggle-mute": {
        const runtimeTabId =
          menuPreviewTabId && menuOverlay
            ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
            : null;
        if (runtimeTabId) {
          void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined);
        }
        break;
      }
      case "close":
        props.onCloseSurface(surface);
        break;
      case "close-others":
        props.onCloseOtherSurfaces(surface);
        break;
      case "close-to-right":
        props.onCloseSurfacesToRight(surface);
        break;
      case "close-all":
        props.onCloseAllSurfaces();
        break;
      case null:
        break;
    }
  };
  const handleTabAuxClick = (event: ReactMouseEvent, surface: RightPanelSurface) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    props.onCloseSurface(surface);
  };
  const onActivateTab = useStableCallback(props.onActivate);
  const onCloseTab = useStableCallback(props.onCloseSurface);
  const onTabAuxClick = useStableCallback(handleTabAuxClick);
  const onTabContextMenu = useStableCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      void handleTabContextMenu(event, surface);
    },
  );
  const onStartRenameTab = useStableCallback((surfaceId: string) => setRenamingDevice(surfaceId));
  const onFinishRenameTab = useStableCallback((surfaceId: string, title: string) => {
    props.onRenameDevice?.(surfaceId, title);
    setRenamingDevice(null);
  });

  useRevealActiveTab(tabListRef, layoutTabId === null ? props.activeSurfaceId : null);

  const attachTabList = (root: HTMLDivElement | null) => {
    tabListRef.current = root;
    const viewport = tabScrollViewport(root);
    if (!viewport) return;

    const update = () => updateTabScrollState(viewport);
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      if (delta === 0) return;

      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
      update();
    };

    const content = viewport.firstElementChild;
    const stopObserving = observeResize(content ? [viewport, content] : viewport, update);
    viewport.addEventListener("scroll", update, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    update();

    return () => {
      tabListRef.current = null;
      stopObserving();
      viewport.removeEventListener("scroll", update);
      viewport.removeEventListener("wheel", handleWheel);
    };
  };

  const addSurfaceMenu =
    // A notch keeps it while empty too: an empty notch reads as a broken corner.
    props.open !== false || props.surfaces.length > 0 || notched ? (
      <Menu open={addSurfaceMenuOpen} onOpenChange={setAddSurfaceMenuOpen}>
        <MenuTrigger
          render={
            <Button
              aria-label="Add panel surface"
              className="shrink-0"
              size="icon-xs"
              variant="ghost-muted"
            />
          }
        >
          <Plus className="size-3.5" />
        </MenuTrigger>
        <MenuPopup
          align="start"
          side="bottom"
          sideOffset={6}
          onKeyDownCapture={handleAddSurfaceMenuKeyDown}
        >
          <SurfaceMenuItems
            actions={addSurfaceActions}
            browserProfiles={browserProfiles}
            onAddBrowserInProfile={props.onAddBrowserInProfile}
            onClose={() => setAddSurfaceMenuOpen(false)}
          />
        </MenuPopup>
      </Menu>
    ) : null;

  return (
    <PreviewPanelShell
      workspaceArea
      workspaceFocusKey={`panel:${props.environmentId}:${props.activeSurfaceId ?? "empty"}`}
      workspaceLabel={
        focusedSurface
          ? `Workspace panel: ${surfaceTitle(focusedSurface, props.previewSessions, props.terminalLabelsById)}`
          : "Workspace panel"
      }
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
      {...(props.pane ? { pane: true } : {})}
      {...(props.inlineSize ? { inlineSize: props.inlineSize } : {})}
    >
      <div
        className={cn(
          // diff-toolbar: the active surface's actions sit in this row and fold
          // into a menu when the pane is narrow (DiffViewControls).
          "@container/diff-toolbar flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1",
          // A layout pane's row lines up with its chat's header and starts at
          // the pane's edge, under its notch.
          notched
            ? cn(
                "relative z-10 ps-1.5 pe-2 md:ps-0",
                (focusedSurface && PANE_BODY_SURFACE_CLASS[focusedSurface.kind]) ?? "bg-background",
              )
            : "pl-2",
          !notched && (props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3"),
          ownsDesktopTitleBar && "drag-region",
          ownsDesktopTitleBar && "wco:pr-(--workspace-native-controls-inset)",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          // The leading embedded pane shares the mobile row with the shell toggle.
          notched && leadingEdge && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
        data-pane-header={notched ? "" : undefined}
      >
        <PanelTabsNotch notched={notched} addButton={addSurfaceMenu}>
          {layoutTabId !== null
            ? siblingTabs.before.map((tab) => <LayoutPaneTab key={tab.id} tab={tab} />)
            : null}
          <PanelTabStrip notched={notched} ref={attachTabList}>
            <SortableTabList surfaces={props.surfaces} onMove={props.onMoveSurface}>
              {props.surfaces.map((surface) => {
                const previewTabId = previewTabIdOf(surface, props.previewSessions);
                const favicon = previewFaviconOf(
                  surface,
                  props.previewSessions,
                  props.desktopByTabId,
                );
                return (
                  <RightPanelTab
                    key={surface.id}
                    surface={surface}
                    // A layout tab's strip drags the whole tab instead.
                    dragDisabled={
                      !props.onMoveSurface || renamingDevice === surface.id || layoutTabId !== null
                    }
                    active={surface.id === props.activeSurfaceId}
                    pending={props.pendingSurfaceIds.has(surface.id)}
                    title={surfaceTitle(surface, props.previewSessions, props.terminalLabelsById)}
                    audio={tabAudioState(
                      previewTabId ? (props.desktopByTabId[previewTabId] ?? null) : null,
                    )}
                    audioRuntimeTabId={
                      previewTabId ? (props.previewRuntimeTabId?.(previewTabId) ?? null) : null
                    }
                    previewUrl={favicon.url}
                    previewCapturedUrl={favicon.capturedUrl}
                    theme={resolvedTheme}
                    environmentId={props.environmentId}
                    pullRequestStatusSeed={props.pullRequestStatusSeeds?.[surface.id]}
                    renaming={renamingDevice === surface.id}
                    canRename={props.onRenameDevice !== undefined}
                    ownsDesktopTitleBar={ownsDesktopTitleBar}
                    notched={notched}
                    layoutTabId={layoutTabId}
                    threadTitle={props.threadTitle ?? null}
                    onBreadcrumbSlotChange={setBreadcrumbSlot}
                    onActivate={onActivateTab}
                    onClose={onCloseTab}
                    onAuxClick={onTabAuxClick}
                    onContextMenu={onTabContextMenu}
                    onStartRename={onStartRenameTab}
                    onFinishRename={onFinishRenameTab}
                  />
                );
              })}
            </SortableTabList>
            {notched ? null : addSurfaceMenu}
          </PanelTabStrip>
          {layoutTabId !== null
            ? siblingTabs.after.map((tab) => <LayoutPaneTab key={tab.id} tab={tab} />)
            : null}
        </PanelTabsNotch>
        {/* In the notch the tabs scroll by wheel and ctrl+Tab; the actions need the room. */}
        {!notched && tabScrollState.hasOverflow ? (
          <div
            className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
            role="group"
            aria-label="Scroll panel tabs"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs left"
                      disabled={!tabScrollState.canScrollLeft}
                      onClick={() => scrollTabs(-1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronLeft />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs left</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs right"
                      disabled={!tabScrollState.canScrollRight}
                      onClick={() => scrollTabs(1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronRight />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs right</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        <PanelActionsNotch
          notched={notched && props.activeSurfaceId !== null}
          hasActions={hasActions || props.layoutControls !== undefined}
        >
          <div
            ref={setActionsSlot}
            className="ms-auto flex shrink-0 items-center gap-0.5 empty:hidden [-webkit-app-region:no-drag]"
            data-right-panel-tab-actions
          />
          {props.layoutControls}
        </PanelActionsNotch>
        {ownsDesktopTitleBar && !props.layoutControls ? (
          <span aria-hidden className="hidden w-24 shrink-0 wco:block" />
        ) : null}
        {ownsDesktopTitleBar ? (
          <span
            aria-hidden
            className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
          />
        ) : null}
      </div>
      <div
        className={cn("flex min-h-0 flex-1 flex-col", notched && PANE_BODY_UNDER_HEADER_CLASS)}
        data-right-panel-surface-content
        data-right-panel-surface-kind={focusedSurface?.kind}
      >
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onClose={props.onClose}
            onAddBrowser={props.onAddBrowser}
            onAddBrowserInProfile={props.onAddBrowserInProfile}
            browserProfiles={browserProfiles}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            onAddPullRequests={props.onAddPullRequests}
            onAddDevice={props.onAddDevice}
            onAddSideChat={props.onAddSideChat}
            browserAvailable={props.browserAvailable}
            browserUnavailableReason={props.browserUnavailableReason}
            terminalAvailable={props.terminalAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            pullRequestAvailable={props.pullRequestAvailable}
            pullRequestsAvailable={props.pullRequestsAvailable}
            deviceAvailable={props.deviceAvailable}
            sideChatAvailable={props.sideChatAvailable === true}
            sideChatDisabledReason={props.sideChatDisabledReason ?? null}
          />
        ) : (
          <PanelTabSlotsContext value={tabSlots}>{props.children}</PanelTabSlotsContext>
        )}
      </div>
    </PreviewPanelShell>
  );
}

function DeviceTabTooltip(props: {
  surface: Extract<RightPanelSurface, { kind: "device" }>;
  environmentId: EnvironmentId | null;
  title: string;
}) {
  const target = props.surface.target;
  const { state } = useDeviceState(target ? props.environmentId : null);
  const device = target
    ? state.devices.find((entry) => entry.hostId === target.hostId && entry.id === target.deviceId)
    : undefined;
  const host = target ? state.hosts.find((entry) => entry.id === target.hostId) : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <span>{props.title}</span>
      {target ? (
        <span className="flex flex-col gap-0.5 text-muted-foreground">
          <span>{host?.label ?? "Device host"}</span>
          <span>{device?.version ?? (target.platform === "ios" ? "iOS" : "Android")}</span>
        </span>
      ) : null}
    </div>
  );
}
