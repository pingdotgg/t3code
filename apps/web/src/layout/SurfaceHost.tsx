import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { kickBrowserSurfaceTracking } from "../browser/browserSurfaceTracking";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { launcherFocusTarget } from "../components/SurfaceLauncher";
import { observeResize } from "../lib/observeResize";
import { SidebarInset } from "../components/ui/sidebar";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { StatusDot } from "../components/ui/status-dot";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn, isMacPlatform } from "../lib/utils";
import { usePaneMotion } from "../motion/paneMotion";
import {
  PanelAnimationSuppressionProvider,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import {
  endUserStripScroll,
  moveStripCamera,
  noteUserStripScroll,
  settleStripCamera,
  userStripScrollAge,
} from "../motion/stripCamera";
import {
  applyWorkspaceStackTransform,
  attachWorkspaceSwitch,
  rememberWorkspaceCamera,
  useWorkspaceStack,
  workspaceCamera,
  workspaceStackCamera,
  type WorkspaceStack,
} from "../motion/workspaceSwitch";
import { LayoutResizeHandles } from "./ColumnResizeHandle";
import { LayoutStripHint } from "./LayoutHint";
import { LayoutOnboarding } from "./LayoutOnboarding";
import { LayoutKeyboard } from "./LayoutShortcutsOverlay";
import { LayoutDropZones } from "./DropZones";
import {
  LayoutOverview,
  OverviewStageOverlay,
  onOverviewBackgroundPointerDown,
  overviewSlotStyle,
  overviewZoomTransition,
  selectOverviewStage,
  useOverviewPhase,
  useOverviewStage,
} from "./Overview";
import { useLayoutBehavior } from "./layoutBehavior";
import { useSyncLayoutBehavior } from "./useSyncLayoutBehavior";
import { ChatPaneStandIn } from "./ChatPaneStandIn";
import { chatHoldsLiveWork, queueChatRender, registerWaitingChat } from "./chatRenderGate";
import { useThreeFingerSwipe } from "./useThreeFingerSwipe";
import { ThreadSurfaceServices, ThreadSurfaceTab } from "../components/ThreadSurfaceTab";
import { findThreadChat, useLayoutSurfaceSync } from "./surfaceSync";
import {
  isLayoutPageContent,
  selectFocusedPane,
  selectFocusedTab,
  selectFocusedWorkspace,
  selectLayoutPaneSlots,
  type LayoutColumn,
  type LayoutSurfaceContent,
  type LayoutLauncherContent,
  type LayoutPaneSlot,
  type LayoutState,
  type LayoutTab,
  type LayoutViewport,
  type LayoutWorkspace,
} from "./layoutModel";
import {
  holdFocusedPaneKeyboard,
  LayoutPaneContext,
  type LayoutPaneState,
} from "./layoutPaneContext";
import { LayoutLauncherPane } from "./NewTabLauncher";
import { PaneThumbnail, PaneThumbnailServices } from "./PaneThumbnail";
import { useThreadStatus } from "../state/entities";
import { setLayoutStripViewportWidth, useLayoutStore } from "./layoutStore";
import { LayoutPageBody } from "./PageSurface";

/**
 * A pane counts as on screen (and its thread highlights in the sidebar) when
 * at least this share of its width is inside the window; a column peeking
 * at the edge does not.
 */
const ON_SCREEN_MIN_SHARE = 0.5;
/**
 * In the overview, a chat not rendered yet renders once its thumbnail is at
 * least this wide; smaller ones draw their thumbnail (PaneThumbnail).
 */
const OVERVIEW_RENDER_MIN_PX = 120;
/**
 * Besides the chats near the camera and the focused one, this many of the
 * most recently near stay rendered; the rest unmount. Each rendered chat
 * holds a ChatView's DOM and memory, and every focus move re-renders them.
 */
const RENDERED_RECENT_CHATS = 8;
/** An off-screen chat past the cap unmounts once it has stayed past it this long. */
const UNRENDER_DELAY_MS = 1500;
/** A modal dialog is open; dialogs portal out of their chat, so any one holds the cap. */
const OPEN_DIALOG_SELECTOR =
  '[aria-modal="true"]:is([role="dialog"], [role="alertdialog"]), [data-slot$="dialog-popup"][data-open]';
/** The strip reports what is on screen once its scroll has settled this long. */
const ON_SCREEN_SCROLL_SETTLE_MS = 120;
/**
 * A user's sideways gesture has ended once their wheel, swipe or drag has
 * been quiet this long; a busy frame can stall it longer than a settle.
 */
const USER_SCROLL_END_MS = 250;
/**
 * A settled scroll is the user's when their gesture moved the strip this
 * recently; a fling keeps scrolling a while after the touch ends.
 */
const USER_SCROLL_SETTLE_WINDOW_MS = 2000;
/**
 * A top pane starting this close to the strip's left edge shares its row with
 * the collapsed sidebar's toggle and arrows, so its header makes room for them.
 */
const WINDOW_START_EDGE_PX = 160;

/** The first off-screen pane an agent opened on each side of the window. */
interface UnseenPeeks {
  left: string | null;
  right: string | null;
}

/**
 * A dot on the peeking edge for a pane an agent opened off screen (pen
 * uQRYP). Clicking it brings the pane in; scrolling to it clears it.
 */
function UnseenPeekDot({ side, tabId }: { side: "left" | "right"; tabId: string }) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "New pane to the left" : "New pane to the right"}
      data-layout-unseen-peek={side}
      className={cn(
        "absolute top-1/2 z-30 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center",
        side === "left" ? "left-0" : "right-0",
      )}
      onClick={() => useLayoutStore.getState().focusTab(tabId)}
    >
      <StatusDot tone="info" size="md" />
    </button>
  );
}

/** Pen R49C1s: neighboring panes share an 8px gutter, independent of the window inset. */
const HALF_PANE_GAP = "4px";

const FULL_RECT = { left: 0, top: 0, width: 1, height: 1 };
const FULL_SLOT: LayoutPaneSlot = {
  paneId: "",
  activeTabId: null,
  rect: FULL_RECT,
  hasLeft: false,
  hasRight: false,
  hasAbove: false,
  hasBelow: false,
};
const FULL_STYLE: React.CSSProperties = { inset: 0 };

/**
 * A closed tab's pane sliding away where it was (motion/paneMotion.ts): a
 * chat or a launcher still drawn, or (a thread's surface, Settings, whose
 * content leaves with them) the flat surface they paint over their pane.
 */
type ClosingTab = { placed: { slot: LayoutPaneSlot; style: React.CSSProperties } } & (
  | {
      kind: "chat";
      tab: LayoutTab;
      paneId: string;
      target: Extract<LayoutTab["content"], { kind: "chat" }>["target"];
    }
  | { kind: "launcher"; context: LayoutLauncherContent["context"] }
  | { kind: "bare" }
);
const NO_GHOSTS: ReadonlyMap<string, ClosingTab> = new Map();

/**
 * Pane edges land on whole pixels, so borders and text stay crisp at any split.
 * Both panes round the same boundary, so the gap between them stays exact.
 */
function slotStyle(slot: LayoutPaneSlot): React.CSSProperties {
  const edge = (has: boolean) => (has ? HALF_PANE_GAP : "0px");
  const at = (fraction: number, offset: string) =>
    `round(calc(${fraction * 100}% + ${offset}), 1px)`;
  const left = at(slot.rect.left, edge(slot.hasLeft));
  const right = at(slot.rect.left + slot.rect.width, `-1 * ${edge(slot.hasRight)}`);
  const top = at(slot.rect.top, edge(slot.hasAbove));
  const bottom = at(slot.rect.top + slot.rect.height, `-1 * ${edge(slot.hasBelow)}`);
  return {
    left,
    top,
    width: `calc(${right} - ${left})`,
    height: `calc(${bottom} - ${top})`,
  };
}

/** One workspace in the stack a switch moves (see motion/workspaceSwitch.ts). */
interface StackRow {
  id: string;
  workspace: LayoutWorkspace | null;
  offset: number;
  slots: LayoutPaneSlot[];
  stripWidth: number;
  /** Its horizontal scroll, in px. */
  camera: number;
}

/**
 * `slotStyle` for a pane in a stacked row: the stage is one window wide,
 * the row sits `offset` rows (and gaps) down and shifts left by its camera.
 * At rest on a row it lands on exactly the strip's pixels.
 */
function stackSlotStyle(row: StackRow, slot: LayoutPaneSlot, gap: number): React.CSSProperties {
  const edge = (has: boolean) => (has ? HALF_PANE_GAP : "0px");
  const across = (fraction: number, offset: string) =>
    `round(calc(${fraction * row.stripWidth * 100}% - ${row.camera}px + ${offset}), 1px)`;
  const down = (fraction: number, offset: string) =>
    `round(calc(${(row.offset + fraction) * 100}% + ${row.offset * gap}px + ${offset}), 1px)`;
  const left = across(slot.rect.left, edge(slot.hasLeft));
  const right = across(slot.rect.left + slot.rect.width, `-1 * ${edge(slot.hasRight)}`);
  const top = down(slot.rect.top, edge(slot.hasAbove));
  const bottom = down(slot.rect.top + slot.rect.height, `-1 * ${edge(slot.hasBelow)}`);
  return { left, top, width: `calc(${right} - ${left})`, height: `calc(${bottom} - ${top})` };
}

/**
 * The panes a workspace shows: all of them, the maximized one alone, or
 * below md only its focused one, full size.
 */
function selectShownSlots(
  workspace: LayoutWorkspace,
  viewport: LayoutViewport,
  narrow: boolean,
  maximizedTabId: string | null,
): {
  slots: LayoutPaneSlot[];
  stripWidth: number;
  fits: boolean;
  unitWidth: number;
  paneCount: number;
} {
  const all = selectLayoutPaneSlots(workspace, viewport);
  const paneCount = all.slots.length;
  // A maximized pane fills the strip (pen O3SkD); below md only the focused one shows.
  const maximizedSlot =
    maximizedTabId === null
      ? null
      : (all.slots.find((slot) => slot.activeTabId === maximizedTabId) ?? null);
  if (paneCount < 2 || (!narrow && !maximizedSlot)) return { ...all, paneCount };
  const onlySlot =
    (narrow ? null : maximizedSlot) ??
    all.slots.find((slot) => slot.paneId === workspace.focusedPaneId) ??
    all.slots[0]!;
  return {
    paneCount: narrow ? 1 : paneCount,
    slots: [
      {
        ...onlySlot,
        rect: FULL_RECT,
        hasLeft: false,
        hasRight: false,
        hasAbove: false,
        hasBelow: false,
      },
    ],
    stripWidth: 1,
    fits: true,
    unitWidth: viewport.width,
  };
}

function selectStackRows(
  stack: WorkspaceStack,
  layout: LayoutState,
  viewport: LayoutViewport,
  narrow: boolean,
  maximizedTabId: string | null,
): StackRow[] {
  return stack.rows.map(({ id, offset }) => {
    // A row's workspace can be gone (an empty one left behind): it shows as empty.
    const workspace = layout.workspaces.find((candidate) => candidate.id === id) ?? null;
    if (!workspace || workspace.columns.length === 0) {
      return { id, workspace, offset, slots: [], stripWidth: 1, camera: 0 };
    }
    const shown = selectShownSlots(workspace, viewport, narrow, maximizedTabId);
    const stripPx = shown.stripWidth * viewport.width;
    return {
      id,
      workspace,
      offset,
      slots: shown.slots,
      stripWidth: shown.stripWidth,
      camera: workspaceStackCamera(workspace, shown.slots, stripPx, viewport.width),
    };
  });
}

/**
 * A split pane narrower than this opens the right panel as a sheet, as a
 * window under the base's 980px breakpoint does.
 */
const LAYOUT_INLINE_RIGHT_PANEL_MIN_PX = 981;

/** The strip's visible width in px, kept current as the window or sidebar resizes. */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the strip DOM width so pane geometry follows window and sidebar resizes
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    return observeResize(element, () => setWidth(element.clientWidth));
  }, [ref]);
  return width;
}

/** The focused pane's span across the strip, in px. */
interface StripSpan {
  left: number;
  width: number;
}

/** Preserve screen positions when the strip edge shifts, except at its start. Reveal focused panes
 * after resizing without exposing trailing chrome. */
function useStripResizeScroll(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  focusedSpanRef: React.RefObject<StripSpan | null>,
  active: boolean,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe strip resizes and preserve its DOM scroll position before paint.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !active) return;
    // The scroll from before the latest resize, as the observer last left it.
    let scrollLeft = scroller.scrollLeft;
    let width = scroller.clientWidth;
    let left = scroller.getBoundingClientRect().left;
    const onScroll = () => {
      // The clamp of a resize the observer has not seen yet: it starts from before it.
      if (scroller.clientWidth !== width) return;
      scrollLeft = scroller.scrollLeft;
    };
    // Runs after layout and before paint.
    const stopObserving = observeResize(scroller, () => {
      if (scroller.clientWidth === width) return;
      const grew = scroller.clientWidth > width;
      width = scroller.clientWidth;
      const nextLeft = scroller.getBoundingClientRect().left;
      const shift = nextLeft - left;
      left = nextLeft;
      // Grown past the strip's end, the browser clamped the scroll before this ran.
      const clamped = grew && scroller.scrollLeft + width >= scroller.scrollWidth - 1;
      const from = clamped ? scrollLeft : scroller.scrollLeft;
      let target =
        Math.abs(shift) < 0.5 ? scroller.scrollLeft : from > 0 ? Math.max(0, from + shift) : 0;
      const focused = focusedSpanRef.current;
      if (focused && focused.left < target - 1) target = focused.left;
      else if (focused && focused.left + focused.width > target + width + 1) {
        target = Math.min(focused.left, focused.left + focused.width - width);
      }
      scrollLeft = target;
      if (Math.abs(target - scroller.scrollLeft) < 0.5) return;
      settleStripCamera();
      scroller.scrollLeft = target;
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stopObserving();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [active, focusedSpanRef, scrollerRef]);
}

/** Pure placement derivations stay separate from the host's retained transition state. */
function useSurfacePlacement(
  shown: LayoutState,
  workspace: LayoutWorkspace,
  viewportWidth: number,
  whenNoRoom: LayoutViewport["whenNoRoom"],
  narrow: boolean,
  maximizedTabId: string | null,
  windowWidth: number,
) {
  const overviewPhase = useOverviewPhase();
  const workspaceStack = useWorkspaceStack();
  const viewport = { width: viewportWidth, whenNoRoom };
  const { slots, stripWidth, fits, unitWidth, paneCount } = selectShownSlots(
    workspace,
    viewport,
    narrow,
    maximizedTabId,
  );
  const chatTabsById = (() => {
    const byId = new Map<string, { tab: LayoutTab; paneId: string }>();
    for (const candidate of shown.workspaces) {
      for (const column of candidate.columns) {
        for (const pane of column.panes) {
          for (const tab of pane.tabs) {
            if (tab.content.kind === "chat") byId.set(tab.id, { tab, paneId: pane.id });
          }
        }
      }
    }
    return byId;
  })();

  const launcherTabsById = (() => {
    const byId = new Map<string, LayoutLauncherContent>();
    for (const candidate of shown.workspaces) {
      for (const column of candidate.columns) {
        for (const pane of column.panes) {
          for (const tab of pane.tabs) {
            if (tab.content.kind === "launcher") byId.set(tab.id, tab.content);
          }
        }
      }
    }
    return byId;
  })();

  const surfaceTabsById = (() => {
    const byId = new Map<string, LayoutSurfaceContent>();
    for (const candidate of shown.workspaces) {
      for (const column of candidate.columns) {
        for (const pane of column.panes) {
          for (const tab of pane.tabs) {
            if (tab.content.kind === "surface") byId.set(tab.id, tab.content);
          }
        }
      }
    }
    return byId;
  })();

  // The overview lays every workspace out on one stage (see Overview.tsx),
  // so the panes it shows are the live ones, zoomed out.
  const staged = overviewPhase !== "closed";
  // The strip's width follows every window resize, so it keys the window's too.
  const stage = selectOverviewStage(shown, viewport, windowWidth);
  // A workspace switch in motion stacks the workspaces it moves between.
  const stacked = !staged && workspaceStack !== null;
  const stackRows =
    workspaceStack === null
      ? []
      : selectStackRows(workspaceStack, shown, viewport, narrow, maximizedTabId);

  const slotByTabId = (() => {
    const byId = new Map<string, { slot: LayoutPaneSlot; style: React.CSSProperties }>();
    if (stacked && workspaceStack) {
      for (const row of stackRows) {
        for (const slot of row.slots) {
          if (slot.activeTabId === null) continue;
          byId.set(slot.activeTabId, {
            slot,
            style: stackSlotStyle(row, slot, workspaceStack.gap),
          });
        }
      }
      return byId;
    }
    if (staged) {
      for (const row of stage.rows) {
        for (const slot of row.slots) {
          if (slot.activeTabId === null) continue;
          byId.set(slot.activeTabId, {
            slot,
            style: overviewSlotStyle(row, slot, stage.gap, HALF_PANE_GAP),
          });
        }
      }
      return byId;
    }
    for (const slot of slots) {
      if (slot.activeTabId !== null) byId.set(slot.activeTabId, { slot, style: slotStyle(slot) });
    }
    return byId;
  })();

  return {
    slots,
    stripWidth,
    fits,
    unitWidth,
    paneCount,
    chatTabsById,
    launcherTabsById,
    surfaceTabsById,
    overviewPhase,
    staged,
    stage,
    workspaceStack,
    stacked,
    stackRows,
    slotByTabId,
  };
}

/** Keep chat tabs in one stable sibling layer. Moving a tab changes only its position, preserving
 * ChatView, terminals, drafts and scroll state. */
export function LayoutSurfaceHost({
  layout,
  active = true,
  background = false,
  pagePlane,
  pagePlaneSplit = false,
}: {
  layout: LayoutState;
  active?: boolean;
  background?: boolean;
  pagePlane?: React.ReactNode;
  pagePlaneSplit?: boolean;
}) {
  // A resize drag previews here and commits to the store once on release.
  const [preview, setPreview] = useState<LayoutState | null>(null);
  const shown = preview ?? layout;
  const workspace = selectFocusedWorkspace(shown);
  const narrow = useMediaQuery("max-md");
  useSyncLayoutBehavior();
  useThreeFingerSwipe(active);
  useLayoutSurfaceSync();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lastWorkspaceFocus = useRef<HTMLElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore focus to the retained workspace element when the workspace returns.
  useLayoutEffect(() => {
    const element = lastWorkspaceFocus.current;
    if (active && element?.isConnected && element.closest('[data-layout-pane-focused="true"]')) {
      element.focus({ preventScroll: true });
    }
  }, [active]);
  const viewportWidth = useElementWidth(scrollerRef);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish the measured desktop strip width for imperative pane placement.
  useEffect(() => {
    // Below md one pane fills the window; columns stay arranged for the last
    // wide one. The first render's guess (the window's width) is not reported.
    if (narrow || scrollerRef.current?.clientWidth !== viewportWidth) return;
    setLayoutStripViewportWidth(viewportWidth);
  }, [narrow, viewportWidth]);
  const focusedPaneId = selectFocusedPane(shown)?.id ?? null;
  const maximizedTabId = useLayoutStore((state) => state.maximizedTabId);
  const { whenNoRoom } = useLayoutBehavior();
  const {
    slots,
    stripWidth,
    fits,
    unitWidth,
    paneCount,
    chatTabsById,
    launcherTabsById,
    surfaceTabsById,
    overviewPhase,
    staged,
    stage,
    workspaceStack,
    stacked,
    stackRows,
    slotByTabId,
  } = useSurfacePlacement(
    shown,
    workspace,
    viewportWidth,
    whenNoRoom,
    narrow,
    maximizedTabId,
    window.innerWidth,
  );
  // One pane is focused. A focused surface tab's chat is only related: it
  // answers its thread's pane toggles (cmd+J, alt+cmd+B) and holds the
  // composer the surface inserts into, without layout or DOM focus.
  const focusedTab = active ? selectFocusedTab(shown) : null;
  const focusedTabId = focusedTab?.id ?? null;
  const relatedChatTabId =
    focusedTab?.content.kind === "surface"
      ? (findThreadChat(shown, focusedTab.content.threadRef)?.tab.id ?? null)
      : null;

  // Mount newly visible tabs in the same render, then keep them mounted until close so workspace
  // switches preserve terminals, drafts and scroll.
  const [shownOrder, setShownOrder] = useState<readonly string[]>([]);
  const [windowStartPaneId, setWindowStartPaneId] = useState<string | null>(null);
  // A focused surface's chat mounts too, wherever it sits, so it answers the
  // surface's thread keys (cmd+J, alt+cmd+B) after a reload as before one.
  const visibleChatTabIds = [
    ...new Set(
      [...slotByTabId.keys(), relatedChatTabId].flatMap((id) =>
        id !== null && chatTabsById.has(id) ? [id] : [],
      ),
    ),
  ];
  const visibleChatTabIdSet = new Set(visibleChatTabIds);
  const hiddenKept = shownOrder.filter(
    (id) => chatTabsById.has(id) && !visibleChatTabIdSet.has(id),
  );
  const nextShownOrder = [...visibleChatTabIds, ...hiddenKept];
  if (
    nextShownOrder.length !== shownOrder.length ||
    nextShownOrder.some((id, index) => id !== shownOrder[index])
  ) {
    setShownOrder(nextShownOrder);
  }
  // Render in a stable order so a focus change never reorders DOM siblings.
  const mountedTabIds = [...nextShownOrder].toSorted();

  // Size long stages in pixels; React learns viewport changes a frame late, and a proportional
  // stage would stretch panes and fling the camera.
  const stripPx = stripWidth * viewportWidth;
  const focusedSlot = slots.find((slot) => slot.paneId === focusedPaneId) ?? null;
  const focusedLeft = focusedSlot ? Math.round(focusedSlot.rect.left * stripPx) : null;
  const focusedWidth = focusedSlot ? Math.round(focusedSlot.rect.width * stripPx) : null;
  const dragging = preview !== null;

  // Where the strip's camera is, in half windows: it changes a couple of
  // times per window of scroll, not per frame, so scrolling re-renders the
  // host rarely.
  const [cameraStep, setCameraStep] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to native scroll and schedule bounded render-window updates.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setCameraStep(Math.floor(scroller.scrollLeft / Math.max(1, viewportWidth / 2)));
    };
    const onScroll = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [viewportWidth]);
  // The chats whose panes are within a window of the camera. A chat renders
  // the first time it comes near, so a strip of a hundred columns renders the
  // few on screen.
  const nearTabIds = (() => {
    const near = new Set<string>();
    const mark = (slot: LayoutPaneSlot) => {
      if (slot.activeTabId !== null) near.add(slot.activeTabId);
    };
    if (staged) {
      // The overview renders the chats it shows big enough to read.
      const thumbScale = (stage.scale * viewportWidth) / window.innerWidth;
      for (const row of stage.rows) {
        for (const slot of row.slots) {
          const width = slot.rect.width * row.stripWidth * viewportWidth * thumbScale;
          if (width >= OVERVIEW_RENDER_MIN_PX) mark(slot);
        }
      }
      return near;
    }
    const add = (slot: LayoutPaneSlot, rowPx: number, camera: number) => {
      const left = slot.rect.left * rowPx;
      const right = left + slot.rect.width * rowPx;
      if (right < camera - viewportWidth || left > camera + 2 * viewportWidth) return;
      mark(slot);
    };
    if (stacked) {
      for (const row of stackRows) {
        for (const slot of row.slots) add(slot, row.stripWidth * viewportWidth, row.camera);
      }
      return near;
    }
    for (const slot of slots) add(slot, stripPx, (cameraStep * viewportWidth) / 2);
    // Focus can land past the camera before the scroll reports it.
    if (focusedSlot) add(focusedSlot, stripPx, focusedSlot.rect.left * stripPx);
    return near;
  })();
  // The chats near the camera, most recently first; the cap keeps the first
  // few that have left. Derived during render, as `shownOrder` is.
  const [recentChatIds, setRecentChatIds] = useState<readonly string[]>([]);
  const nextRecentChatIds = [
    ...[...nearTabIds].filter((id) => chatTabsById.has(id)),
    ...recentChatIds.filter((id) => chatTabsById.has(id) && !nearTabIds.has(id)),
  ];
  if (
    nextRecentChatIds.length !== recentChatIds.length ||
    nextRecentChatIds.some((id, index) => id !== recentChatIds[index])
  ) {
    setRecentChatIds(nextRecentChatIds);
  }
  const keptTabIds = (() => {
    const kept = new Set(nearTabIds);
    if (focusedTabId !== null) kept.add(focusedTabId);
    if (relatedChatTabId !== null) kept.add(relatedChatTabId);
    let recent = 0;
    for (const id of recentChatIds) {
      if (recent >= RENDERED_RECENT_CHATS) break;
      if (kept.has(id)) continue;
      kept.add(id);
      recent += 1;
    }
    return kept;
  })();
  const unseenTabIds = useLayoutStore((state) => state.unseenTabIds);
  const [unseenPeeks, setUnseenPeeks] = useState<UnseenPeeks>({ left: null, right: null });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  // The switch's stack and the strip trade places: entering, the stage spans
  // one window and each row carries its own scroll; leaving, the strip
  // scrolls to where its row was drawn. Before any other effect reads the scroll.
  const wasStacked = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Transfer DOM scroll and transforms when entering or leaving the workspace stack.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const element = stageRef.current;
    if (!scroller || !element) return;
    if (stacked) {
      for (const row of stackRows) rememberWorkspaceCamera(row.id, row.camera);
      wasStacked.current = true;
      scroller.scrollLeft = 0;
      applyWorkspaceStackTransform();
      return;
    }
    if (!wasStacked.current) return;
    wasStacked.current = false;
    // The overview took the stage mid-switch and places it itself.
    if (staged) return;
    element.style.transform = "";
    scroller.scrollLeft = workspaceCamera(workspace.id) ?? 0;
  }, [stackRows, stacked, staged, workspace.id]);

  // Kept current for the switch, which reads them between renders.
  const stagedRef = useRef(staged);
  const backgroundRef = useRef(background);
  const stageGapRef = useRef(stage.gap);
  const stripShown = !staged && !stacked && !narrow && maximizedTabId === null && !dragging;
  const stripShownRef = useRef(stripShown);
  const focusedSpanRef = useRef<StripSpan | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish committed geometry and modal ownership for native gesture callbacks.
  useLayoutEffect(() => {
    stagedRef.current = staged;
    backgroundRef.current = background;
    stageGapRef.current = stage.gap;
    stripShownRef.current = stripShown;
    focusedSpanRef.current =
      focusedLeft === null || focusedWidth === null
        ? null
        : { left: focusedLeft, width: focusedWidth };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Attach workspace gestures to the mounted strip DOM and release them on cleanup.
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollerRef.current;
    const element = stageRef.current;
    if (!root || !scroller || !element) return;
    return attachWorkspaceSwitch({
      root,
      scroller,
      stage: element,
      gap: () => stageGapRef.current,
      blocked: () => stagedRef.current || backgroundRef.current,
      stripShown: () => stripShownRef.current,
    });
  }, [backgroundRef, stageGapRef, stagedRef, stripShownRef]);

  // Before the reveal below: leaving the overview hands the strip its scroll
  // back first, so the reveal finds the focused pane in place, not a strip
  // still at 0 that it would spring sideways.
  useOverviewStage(overviewPhase, stage, scrollerRef, stageRef);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reveal the committed focused pane with an imperative camera move after measuring its DOM.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const element = stageRef.current;
    if (!scroller || !element || staged || stacked || dragging) return;
    if (focusedPaneId === null || focusedLeft === null || focusedWidth === null) return;
    // The first render sizes the strip for the window's width, before the
    // scroller is measured, and a scroll then clamps short of the pane. The
    // render with the measured width reveals it.
    if (scroller.clientWidth !== viewportWidth) return;
    const left = focusedLeft;
    const right = left + focusedWidth;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;
    let target: number | null = null;
    if (left < viewLeft - 1) target = left;
    else if (right > viewRight + 1) target = Math.min(left, right - scroller.clientWidth);
    if (target === null) return;
    // The scroll lands at once and the stage springs there on the compositor,
    // so the composer's caret scroll, right after, finds the pane in place.
    moveStripCamera(scroller, element, target);
  }, [dragging, focusedLeft, focusedPaneId, focusedWidth, stacked, staged, viewportWidth]);

  useStripResizeScroll(
    scrollerRef,
    focusedSpanRef,
    !staged && !stacked && !narrow && maximizedTabId === null,
  );

  // alt+cmd+C: center the focused column in the window (a one-shot scroll).
  const centerRequest = useLayoutStore((state) => state.centerRequest);
  const handledCenterRequest = useRef(centerRequest);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll the DOM strip in response to an external center request.
  useLayoutEffect(() => {
    if (handledCenterRequest.current === centerRequest) return;
    handledCenterRequest.current = centerRequest;
    const scroller = scrollerRef.current;
    const element = stageRef.current;
    if (!scroller || !element || focusedLeft === null || focusedWidth === null) return;
    const center = focusedLeft + focusedWidth / 2;
    const target = Math.max(
      0,
      Math.min(stripPx - scroller.clientWidth, center - scroller.clientWidth / 2),
    );
    if (Math.abs(target - scroller.scrollLeft) < 1) return;
    moveStripCamera(scroller, element, target);
  }, [centerRequest, focusedLeft, focusedWidth, stripPx]);

  // Hold alt+cmd and the strip follows the wheel sideways and a middle-button
  // drag, wherever the pointer is (pen ZlxmK). Up and down switch workspaces
  // (motion/workspaceSwitch.ts). Any sideways scroll of the user's takes the
  // camera over from a spring in flight.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own wheel and swipe subscriptions on the mounted workspace scroller.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const mac = isMacPlatform(navigator.platform);
    const held = (event: MouseEvent) =>
      mac ? event.metaKey && event.altKey : event.ctrlKey && event.altKey;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      // A pane's code, diff or tab scroller must not take over the strip's
      // camera. Plain strip gestures start on a notch or in a gap (pen ZlxmK).
      if (
        !held(event) &&
        event.target instanceof Element &&
        event.target.closest("[data-layout-pane-id]") &&
        !event.target.closest("[data-pane-header]")
      )
        return;
      settleStripCamera();
      noteUserStripScroll();
      if (!held(event)) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaX;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 1 || !held(event)) return;
      event.preventDefault();
      settleStripCamera();
      const startX = event.clientX;
      const startLeft = scroller.scrollLeft;
      const move = (moveEvent: PointerEvent) => {
        noteUserStripScroll();
        scroller.scrollLeft = startLeft - (moveEvent.clientX - startX);
      };
      const end = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
    };
    // A finger drags the scroll itself, so it lands the camera where it shows.
    const onTouchMove = () => {
      settleStripCamera();
      noteUserStripScroll();
    };
    scroller.addEventListener("wheel", onWheel, { passive: false, capture: true });
    scroller.addEventListener("pointerdown", onPointerDown, true);
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", onWheel, true);
      scroller.removeEventListener("pointerdown", onPointerDown, true);
      scroller.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  // The pane each column focuses when focus follows the view back to it.
  const lastFocusedPaneByColumn = useRef(new Map<string, string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Remember the committed focused pane for later native scroll focus restoration.
  useEffect(() => {
    if (focusedPaneId === null) return;
    const column = workspace.columns.find((candidate) =>
      candidate.panes.some((pane) => pane.id === focusedPaneId),
    );
    if (column) lastFocusedPaneByColumn.current.set(column.id, focusedPaneId);
  }, [focusedPaneId, workspace]);

  // The sidebar highlights every thread on screen (pen r45lm). Derived from
  // the slots and the strip's settled scroll position, never per frame.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to settled strip scrolling and publishes the DOM-visible panes to the shared layout registry
  useEffect(() => {
    if (!active) {
      useLayoutStore.getState().setOnScreenThreadKeys(new Set());
      return;
    }
    if (dragging || staged || stacked) return;
    const scroller = scrollerRef.current;
    // Focus follows the view, as in niri: once a sideways scroll of the
    // user's settles with the focused pane under half on screen, the column
    // most in view takes focus, with the pane it last focused.
    const followView = (viewStart: number, viewEnd: number) => {
      const store = useLayoutStore.getState();
      const { columns, focusedPaneId: focusedId } = selectFocusedWorkspace(store.layout);
      const slotByPane = new Map(slots.map((slot) => [slot.paneId, slot]));
      const inside = (slot: LayoutPaneSlot) =>
        Math.min(slot.rect.left + slot.rect.width, viewEnd) - Math.max(slot.rect.left, viewStart);
      const focused = focusedId === null ? undefined : slotByPane.get(focusedId);
      if (!focused) return;
      const share = Math.min(focused.rect.width, viewEnd - viewStart) * ON_SCREEN_MIN_SHARE;
      if (inside(focused) >= share) return;
      let best: LayoutColumn | null = null;
      let bestInside = 0;
      for (const column of columns) {
        const slot = column.panes[0] ? slotByPane.get(column.panes[0].id) : undefined;
        const shown = slot ? inside(slot) : 0;
        if (shown > bestInside) {
          best = column;
          bestInside = shown;
        }
      }
      if (!best) return;
      const remembered = lastFocusedPaneByColumn.current.get(best.id);
      const fromColumn = columns.find((column) =>
        column.panes.some((pane) => pane.id === focusedId),
      );
      const index = fromColumn?.panes.findIndex((pane) => pane.id === focusedId) ?? 0;
      const pane =
        best.panes.find((candidate) => candidate.id === remembered) ??
        best.panes[Math.min(Math.max(index, 0), best.panes.length - 1)]!;
      store.focusPane(pane.id);
    };
    const compute = (settled = false) => {
      // In shares of the strip, which the window may clip on the right.
      const measured = scroller !== null && stripPx > 0;
      const viewStart = measured ? scroller.scrollLeft / stripPx : 0;
      const viewEnd = measured ? (scroller.scrollLeft + scroller.clientWidth) / stripPx : 1;
      if (settled && measured && userStripScrollAge() <= USER_SCROLL_SETTLE_WINDOW_MS) {
        endUserStripScroll();
        followView(viewStart, viewEnd);
      }
      const keys = new Set<string>();
      const seen: string[] = [];
      const peeks: UnseenPeeks = { left: null, right: null };
      for (const slot of slots) {
        if (slot.activeTabId === null) continue;
        const inside =
          Math.min(slot.rect.left + slot.rect.width, viewEnd) - Math.max(slot.rect.left, viewStart);
        const unseen = unseenTabIds.has(slot.activeTabId);
        if (inside < slot.rect.width * ON_SCREEN_MIN_SHARE) {
          if (unseen) {
            const side = slot.rect.left < viewStart ? "left" : "right";
            if (peeks[side] === null) peeks[side] = slot.activeTabId;
          }
          continue;
        }
        if (unseen) seen.push(slot.activeTabId);
        // A surface tab on screen counts for its thread, as its chat would.
        const surface = surfaceTabsById.get(slot.activeTabId);
        const chat = chatTabsById.get(slot.activeTabId);
        if (surface) keys.add(scopedThreadKey(surface.threadRef));
        else if (chat?.tab.content.kind === "chat" && chat.tab.content.target.kind === "server") {
          keys.add(scopedThreadKey(chat.tab.content.target.threadRef));
        }
      }
      useLayoutStore.getState().setOnScreenThreadKeys(keys);
      useLayoutStore.getState().markTabsSeen(seen);
      setUnseenPeeks((current) =>
        current.left === peeks.left && current.right === peeks.right ? current : peeks,
      );
      // The top pane at the window's left edge, wherever the strip scrolled.
      let startPaneId: string | null = null;
      let startPx = Number.POSITIVE_INFINITY;
      for (const slot of slots) {
        if (slot.hasAbove) continue;
        const screenLeft = (slot.rect.left - viewStart) * stripPx;
        if (screenLeft > -1 && screenLeft < WINDOW_START_EDGE_PX && screenLeft < startPx) {
          startPx = screenLeft;
          startPaneId = slot.paneId;
        }
      }
      setWindowStartPaneId(startPaneId);
    };
    compute();
    if (!scroller) return;
    let timer: number | null = null;
    const settle = () => {
      // The user's gesture may still be going between its scroll events.
      const age = userStripScrollAge();
      if (age < USER_SCROLL_END_MS) {
        timer = window.setTimeout(settle, USER_SCROLL_END_MS - age);
        return;
      }
      timer = null;
      compute(true);
    };
    const onScroll = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(settle, ON_SCREEN_SCROLL_SETTLE_MS);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [
    active,
    chatTabsById,
    surfaceTabsById,
    dragging,
    slots,
    stacked,
    staged,
    stripPx,
    unseenTabIds,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the shared on-screen thread registry when the strip unmounts
  useEffect(() => () => useLayoutStore.getState().setOnScreenThreadKeys(new Set()), []);

  const surfaceSlots = [...slotByTabId].flatMap(([tabId, placed]) => {
    const content = surfaceTabsById.get(tabId);
    return content ? [{ placed, tabId, content }] : [];
  });
  const launcherSlots = [...slotByTabId].flatMap(([tabId, placed]) => {
    const content = launcherTabsById.get(tabId);
    return content ? [{ placed, tabId, content }] : [];
  });
  const emptyWorkspace = workspace.columns.length === 0;
  // Mid-switch the panes of the workspace being left are staged.
  const focusedWorkspacePaneIds = new Set(
    workspace.columns.flatMap((column) => column.panes.map((pane) => pane.id)),
  );
  const still = (paneId: string | undefined) =>
    staged || (stacked && (paneId === undefined || !focusedWorkspacePaneIds.has(paneId)));

  // Panes open, close and shift with niri's window motion (motion/paneMotion.ts)
  // on the plain strip; a resize drag, a switch, the overview and the window
  // resizing move them 1:1.
  const paneMotionKey =
    staged || stacked || dragging || narrow ? null : `${workspace.id}:${viewportWidth}`;
  const [ghosts, setGhosts] = useState<ReadonlyMap<string, ClosingTab>>(NO_GHOSTS);
  const presentTabIds = new Set(
    shown.workspaces.flatMap((candidate) =>
      candidate.columns.flatMap((column) =>
        column.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id)),
      ),
    ),
  );
  const tabIdsKey = [...presentTabIds].join();
  // The tabs and their places as last drawn; a resize drag leaves them be.
  const [seen, setSeen] = useState({
    key: tabIdsKey,
    chats: chatTabsById,
    launchers: launcherTabsById,
    placed: slotByTabId,
    motionKey: paneMotionKey,
    framed: paneCount > 1 || maximizedTabId !== null,
  });
  if (
    !dragging &&
    (seen.key !== tabIdsKey || seen.placed !== slotByTabId || seen.motionKey !== paneMotionKey)
  ) {
    setSeen({
      key: tabIdsKey,
      chats: chatTabsById,
      launchers: launcherTabsById,
      placed: slotByTabId,
      motionKey: paneMotionKey,
      framed: paneCount > 1 || maximizedTabId !== null,
    });
    // A tab closed from the strip leaves a ghost of its pane behind; the
    // window's lone pane has nothing beside it to slide under, it just goes.
    if (
      seen.key !== tabIdsKey &&
      seen.framed &&
      paneMotionKey !== null &&
      seen.motionKey === paneMotionKey
    ) {
      const closed: [string, ClosingTab][] = [];
      for (const [tabId, placed] of seen.placed) {
        if (presentTabIds.has(tabId) || ghosts.has(tabId)) continue;
        const chat = seen.chats.get(tabId);
        const launcher = seen.launchers.get(tabId);
        if (chat?.tab.content.kind === "chat") {
          closed.push([tabId, { kind: "chat", ...chat, target: chat.tab.content.target, placed }]);
        } else if (launcher) {
          closed.push([tabId, { kind: "launcher", context: launcher.context, placed }]);
        } else {
          closed.push([tabId, { kind: "bare", placed }]);
        }
      }
      if (closed.length > 0) setGhosts((current) => new Map([...current, ...closed]));
    }
  }
  if (paneMotionKey === null && ghosts.size > 0) setGhosts(NO_GHOSTS);
  const dropGhost = (tabId: string) =>
    setGhosts((current) => {
      if (!current.has(tabId)) return current;
      const next = new Map(current);
      next.delete(tabId);
      return next;
    });
  // Maximized, the lone pane keeps its split look so its tabs stay on the chrome.
  // Stacked mid-switch, every pane draws its own, as in the overview. While
  // a closed pane slides off, the one left keeps it too, until it rests.
  const split = paneCount > 1 || maximizedTabId !== null || stacked || ghosts.size > 0;
  usePaneMotion(
    stageRef,
    paneMotionKey,
    paneCount > 1 || maximizedTabId !== null || ghosts.size > 0,
    dropGhost,
    [slotByTabId, ghosts],
  );
  // Browser webviews float over their slots: after anything that may move a
  // pane (a layout change, a switch, the overview, pane motion), they follow,
  // from this very frame. After the motion above, so they start where it does.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reposition external browser surfaces after committed pane geometry and transforms change.
  useLayoutEffect(() => kickBrowserSurfaceTracking({ now: true }));
  const renderedTabIds = [
    ...new Set([
      ...mountedTabIds,
      ...[...ghosts].flatMap(([id, ghost]) =>
        ghost.kind === "chat" && !chatTabsById.has(id) ? [id] : [],
      ),
    ]),
  ].toSorted();
  // An empty workspace opened above the stack points back down, not up.
  const topEmptyId =
    shown.workspaces.length > 1 && shown.workspaces[0]!.columns.length === 0
      ? shown.workspaces[0]!.id
      : null;
  const emptyRows = staged ? stage.rows.filter((row) => row.workspace.columns.length === 0) : [];
  const pageTabs = shown.workspaces.flatMap((candidate) =>
    candidate.columns.flatMap((column) =>
      column.panes.flatMap((pane) => pane.tabs.filter((tab) => isLayoutPageContent(tab.content))),
    ),
  );
  return (
    <SidebarInset
      // An empty workspace is the bare window chrome, artwork included.
      // An empty workspace is a lone pane holding the launcher, like the
      // last tab's pane was, so closing that tab changes nothing around it.
      variant={(!active ? pagePlaneSplit : split) ? "split" : "pane"}
      className="relative h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
      ref={rootRef}
    >
      <div
        ref={scrollerRef}
        data-layout-strip=""
        data-layout-clip={staged ? undefined : ""}
        inert={!active}
        onFocusCapture={(event) => {
          if (active && event.target instanceof HTMLElement) {
            lastWorkspaceFocus.current = event.target;
          }
        }}
        onPointerDown={staged ? onOverviewBackgroundPointerDown : undefined}
        className={cn(
          "relative min-h-0 flex-1 overscroll-x-none",
          !active && "pointer-events-none absolute inset-0 invisible",
          // Panes round their own cuts against the scrolling strip (PaneCuts);
          // a workspace switch rounds the rows it slides past the window.
          split && stacked && "rounded-pane",
          // Stacked, nothing may scroll it: a composer taking focus in the
          // row below would scroll that row into view under the motion.
          stacked
            ? "overflow-clip"
            : stripWidth > 1 && !staged
              ? "overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              : "overflow-hidden",
        )}
      >
        {staged ? (
          // The window chrome behind the zoomed-out stage, over the sidebar (pen rg38s).
          <div
            aria-hidden
            data-chrome-scope=""
            className={cn(
              "fixed inset-0 z-30 bg-(--app-chrome-background) motion-safe:transition-opacity motion-safe:starting:opacity-0",
              overviewPhase === "closing" && "opacity-0",
            )}
            style={overviewZoomTransition()}
          />
        ) : null}
        <div
          ref={stageRef}
          data-layout-stage=""
          className={cn(
            "origin-top-left",
            staged
              ? "fixed top-(--overview-frame-top) left-(--overview-frame-left) z-30 h-(--overview-frame-height) w-(--overview-frame-width)"
              : "relative isolate h-full",
            // A pane sliding in or out past the strip's edge must not grow
            // what the strip can scroll: a composer focusing mid-slide would
            // scroll the strip to its caret, jumping the whole view.
            !staged && !stacked && "overflow-clip",
          )}
          style={
            staged
              ? undefined
              : stacked || fits
                ? { width: "100%" }
                : // At least the window: a window that grew past the strip's end
                  // stretches it before React learns the new width.
                  { width: `${stripPx}px`, minWidth: "100%" }
          }
        >
          {renderedTabIds.map((tabId) => {
            const entry = chatTabsById.get(tabId);
            const ghost = entry ? null : ghosts.get(tabId);
            if (ghost?.kind === "chat") {
              return (
                <LayoutChatSurface
                  key={tabId}
                  tab={ghost.tab}
                  paneId={ghost.paneId}
                  target={ghost.target}
                  placed={ghost.placed}
                  near
                  kept
                  focused={false}
                  related={false}
                  atWindowStart={false}
                  split
                  staged={false}
                  overview={false}
                  closing
                  narrow={false}
                />
              );
            }
            if (!entry || entry.tab.content.kind !== "chat") return null;
            return (
              <LayoutChatSurface
                key={tabId}
                tab={entry.tab}
                paneId={entry.paneId}
                target={entry.tab.content.target}
                placed={slotByTabId.get(tabId) ?? null}
                near={nearTabIds.has(tabId)}
                kept={keptTabIds.has(tabId)}
                focused={tabId === focusedTabId}
                background={background}
                related={tabId === relatedChatTabId}
                atWindowStart={
                  windowStartPaneId === null
                    ? undefined
                    : slotByTabId.get(tabId)?.slot.paneId === windowStartPaneId
                }
                split={split}
                staged={still(slotByTabId.get(tabId)?.slot.paneId)}
                overview={staged}
                narrow={
                  split &&
                  (slotByTabId.get(tabId)?.slot.rect.width ?? 1) * stripWidth * viewportWidth <
                    LAYOUT_INLINE_RIGHT_PANEL_MIN_PX
                }
                active={active}
              />
            );
          })}
          {pageTabs.map((tab) =>
            isLayoutPageContent(tab.content) ? (
              <LayoutPageSurface
                key={tab.id}
                tabId={tab.id}
                placed={slotByTabId.get(tab.id) ?? null}
                focused={active && focusedTab?.id === tab.id}
                active={active}
                atWindowStart={
                  windowStartPaneId === null
                    ? undefined
                    : slotByTabId.get(tab.id)?.slot.paneId === windowStartPaneId
                }
                split={split}
                staged={still(slotByTabId.get(tab.id)?.slot.paneId)}
              >
                <LayoutPageBody content={tab.content} />
              </LayoutPageSurface>
            ) : null,
          )}
          {launcherSlots.map(({ placed, tabId, content }) => (
            <LayoutLauncherSurface
              key={tabId}
              tabId={tabId}
              context={content.context}
              placed={placed}
              // Under the overview every launcher draws itself: it is light,
              // and a bare pane there reads as one missing.
              near={staged || nearTabIds.has(tabId) || focusedTab?.id === tabId}
              focused={focusedTab?.id === tabId}
              atWindowStart={
                windowStartPaneId === null ? undefined : placed.slot.paneId === windowStartPaneId
              }
              split={split}
              staged={still(placed.slot.paneId)}
            />
          ))}
          {[...ghosts].map(([tabId, ghost]) =>
            ghost.kind === "launcher" ? (
              <LayoutLauncherSurface
                key={tabId}
                tabId={tabId}
                context={ghost.context}
                placed={ghost.placed}
                near
                focused={false}
                atWindowStart={false}
                split
                staged={false}
                closing
              />
            ) : ghost.kind === "bare" ? (
              <div
                key={tabId}
                aria-hidden
                inert
                data-layout-closing={tabId}
                className="pointer-events-none absolute overflow-clip rounded-pane bg-background"
                style={ghost.placed.style}
              />
            ) : null,
          )}
          {surfaceSlots.map(({ placed, tabId, content }) => (
            <LayoutSurfaceTabSurface
              key={tabId}
              active={active}
              tabId={tabId}
              content={content}
              placed={placed}
              near={nearTabIds.has(tabId) || focusedTab?.id === tabId}
              focused={focusedTab?.id === tabId}
              atWindowStart={
                windowStartPaneId === null ? undefined : placed.slot.paneId === windowStartPaneId
              }
              split={split}
              staged={still(placed.slot.paneId)}
              overview={staged}
            />
          ))}
          {staged ? (
            emptyRows.map((row) => (
              <LayoutEmptyWorkspace
                key={row.workspace.id}
                style={overviewSlotStyle(row, FULL_SLOT, stage.gap, HALF_PANE_GAP)}
                top={row.workspace.id === topEmptyId}
                active={false}
              />
            ))
          ) : stacked && workspaceStack ? (
            stackRows
              .filter((row) => row.slots.length === 0)
              .map((row) => (
                <LayoutEmptyWorkspace
                  key={row.id}
                  style={stackSlotStyle(row, FULL_SLOT, workspaceStack.gap)}
                  top={row.id === topEmptyId}
                  active={false}
                />
              ))
          ) : emptyWorkspace ? (
            <LayoutEmptyWorkspace
              style={FULL_STYLE}
              top={workspace.id === topEmptyId}
              active={active}
            />
          ) : null}
          {staged ? (
            <OverviewStageOverlay layout={shown} stage={stage} phase={overviewPhase} />
          ) : null}
          {split && slots.length > 1 && !staged && !stacked ? (
            <LayoutResizeHandles
              layout={layout}
              workspace={workspace}
              slots={slots}
              stripWidth={stripPx / unitWidth}
              unitWidth={unitWidth}
              scrollerRef={scrollerRef}
              onPreview={setPreview}
            />
          ) : null}
        </div>
      </div>
      <ThreadSurfaceServices />
      {pagePlane}
      {active ? (
        <>
          <LayoutStripHint />
          <LayoutOnboarding />
          <LayoutDropZones />
          <LayoutKeyboard />
          <LayoutOverview />
          <PaneThumbnailServices />
          {unseenPeeks.left && !stacked ? (
            <UnseenPeekDot side="left" tabId={unseenPeeks.left} />
          ) : null}
          {unseenPeeks.right && !stacked ? (
            <UnseenPeekDot side="right" tabId={unseenPeeks.right} />
          ) : null}
        </>
      ) : null}
    </SidebarInset>
  );
}

function LayoutChatSurface({
  tab,
  paneId,
  target,
  placed,
  near,
  kept,
  focused,
  background = false,
  related,
  atWindowStart,
  split,
  staged,
  overview,
  narrow,
  closing = false,
  active = true,
}: {
  tab: LayoutTab;
  paneId: string;
  target: Extract<LayoutTab["content"], { kind: "chat" }>["target"];
  placed: { slot: LayoutPaneSlot; style: React.CSSProperties } | null;
  /** Within a window of the camera: a chat not rendered yet renders now. */
  near: boolean;
  /** Near, focused or recently near: a rendered chat stays rendered. */
  kept: boolean;
  focused: boolean;
  background?: boolean;
  /** A surface tab of its thread has focus (see `LayoutPaneState.related`). */
  related: boolean;
  /** Whether this pane starts at the window's left edge; unset reads the slot. */
  atWindowStart: boolean | undefined;
  split: boolean;
  /** Under the overview or off the focused workspace mid-switch: draws its own pane. */
  staged: boolean;
  /** Under the overview: inert, and a chat not rendered yet draws its thumbnail. */
  overview: boolean;
  narrow: boolean;
  /** Closed: a ghost sliding away, gone once its animation ends. */
  closing?: boolean;
  active?: boolean;
}) {
  const slot = placed?.slot ?? null;
  // Focus that lands here from the keyboard (alt+cmd arrows, closing a
  // surface tab) moves the caret into the composer. A press already put it
  // where the user wanted.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // The palette puts the caret back itself, through the composer handle.
  usePaneKeyboard(surfaceRef, focused, chatKeyboardTarget, false);
  const visible = slot !== null;
  const leadingEdge = slot ? (atWindowStart ?? (!slot.hasLeft && !slot.hasAbove)) : true;
  const trailingEdge = slot ? !slot.hasRight && !slot.hasAbove : true;
  const paneState = {
    tabId: tab.id,
    paneId,
    // Staged, every pane draws its own; a window-fixed header cluster would
    // land in the stage's corner, over whichever workspace sits on top.
    split: split || staged,
    narrow,
    leadingEdge,
    trailingEdge,
    focused: focused && !background,
    related: related && !background,
    visible: active && visible,
  } satisfies LayoutPaneState;
  // A press inside a pane makes it the focused pane; the URL follows. Focus
  // events are left alone so a pane's own autofocus cannot steal focus.
  const claimFocus = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    const store = useLayoutStore.getState();
    if (selectFocusedTab(store.layout)?.id === tab.id) return;
    store.focusTab(tab.id);
  };

  return (
    <div
      ref={surfaceRef}
      data-layout-tab-id={closing ? undefined : tab.id}
      data-layout-pane-id={visible && !closing ? paneId : undefined}
      data-layout-closing={closing ? tab.id : undefined}
      data-layout-pane-focused={focused ? "true" : undefined}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        closing && "pointer-events-none",
        // Off screen: skip its rendering but keep its layout state, so the
        // timeline's scroll position and the terminal's size survive.
        !visible && "pointer-events-none inset-0 [content-visibility:hidden]",
        visible && (split || staged) && "overflow-clip rounded-pane pane-surface",
      )}
      style={placed?.style}
      // Not inert mid-switch: flipping inert restyles a whole rendered chat,
      // and the panes leaving go hidden (and inert) as soon as it lands.
      inert={!visible || overview || closing}
      onPointerDownCapture={claimFocus}
    >
      <LayoutChatSurfaceBody
        paneState={paneState}
        tab={tab}
        target={target}
        background={background}
        near={near}
        kept={kept}
        thumbnail={overview}
      />
      {visible && split && !staged ? <PaneCuts /> : null}
    </div>
  );
}

/**
 * Memoized so a resize drag, which restyles every surface each frame, does
 * not re-render the ChatViews inside them.
 */
const LayoutChatSurfaceBody = memo(function LayoutChatSurfaceBody({
  paneState,
  tab,
  target,
  background,
  near,
  kept,
  thumbnail,
}: {
  paneState: LayoutPaneState;
  tab: LayoutTab;
  target: Extract<LayoutTab["content"], { kind: "chat" }>["target"];
  background: boolean;
  near: boolean;
  kept: boolean;
  /** Under the overview: a chat not rendered yet draws its thumbnail at once. */
  thumbnail: boolean;
}) {
  // Panel motion holds off for this chat's own first frame and thread swaps.
  // The window-wide suppression flips on every navigation, and every focus
  // move navigates, so it re-rendered every mounted chat twice per keypress.
  const panelAnimationsSuppressed = usePanelNavigationSuppression(
    target.kind === "draft" ? `draft:${target.draftId}` : scopedThreadKey(target.threadRef),
  );
  // Paint the pane before rendering ChatView in a separate task. Avoid transitions, whose
  // interruption can destroy the composer editor beneath the pane.
  const [rendered, setRendered] = useState(false);
  const wanted = paneState.visible && near;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Schedule live chat mounting through the shared render queue and cancel stale requests.
  useEffect(() => {
    if (rendered || !wanted) return;
    return queueChatRender(
      () => setRendered(true),
      paneState.focused || paneState.related ? "focused" : "normal",
    );
  }, [paneState.focused, paneState.related, rendered, wanted]);
  // Past the cap, it unmounts once the user has moved on. Its draft, scroll
  // position, side pane and terminal live outside it and come back with it.
  // Never while it has the keyboard, live work or an open dialog.
  const { tabId } = paneState;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Delay offscreen chat unmounting while DOM focus, dialogs or provider work still hold it.
  useEffect(() => {
    if (kept || !rendered) return;
    let timer = 0;
    const unrender = () => {
      const typing = document.activeElement?.closest("[data-layout-tab-id]");
      const busy =
        typing?.getAttribute("data-layout-tab-id") === tabId ||
        document.querySelector(OPEN_DIALOG_SELECTOR) !== null ||
        chatHoldsLiveWork(target);
      if (busy) timer = window.setTimeout(unrender, UNRENDER_DELAY_MS * 4);
      else setRendered(false);
    };
    timer = window.setTimeout(unrender, UNRENDER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [kept, rendered, tabId, target]);
  // Prepare hidden thumbnails before overview opens. Keep them over chats until their own thread
  // loads, preventing empty or borrowed timelines.
  const [drawn, setDrawn] = useState(false);
  if (!rendered && thumbnail && !drawn) setDrawn(true);
  if (rendered && !thumbnail && drawn) setDrawn(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Schedule offscreen thumbnail construction through the bounded render queue.
  useEffect(() => {
    if (rendered || drawn || near) return;
    return queueChatRender(() => setDrawn(true), "later");
  }, [drawn, near, rendered]);
  const covering = rendered && drawn;
  const threadStatus = useThreadStatus(
    covering && target.kind === "server" ? target.threadRef : null,
  );
  const loaded =
    target.kind === "draft" || (threadStatus !== "empty" && threadStatus !== "synchronizing");
  // A turn after it loads, so the chat has painted its timeline under it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the thumbnail cover only after the loaded chat has had a turn to paint.
  useEffect(() => {
    if (!covering || !loaded) return;
    return queueChatRender(() => setDrawn(false), "normal");
  }, [covering, loaded]);
  // A shortcut for this chat arriving before then renders it at once.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register an unrendered chat with the external shortcut wake-up registry.
  useEffect(() => {
    if (rendered || tabId === null) return;
    return registerWaitingChat(tabId, () => setRendered(true));
  }, [rendered, tabId]);
  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <LayoutPaneContext value={paneState}>
        {rendered ? (
          <ThreadRouteView
            target={target}
            tabId={paneState.tabId}
            background={background}
            // The URL stays on the chat while its surface tab has focus.
            focused={paneState.focused || paneState.related}
          />
        ) : null}
        {/* Near on the strip it is about to render: its stand-in, as before. */}
        {drawn && (thumbnail || !near) ? (
          <PaneThumbnail
            tab={tab}
            paneId={paneState.paneId}
            leadingEdge={paneState.leadingEdge}
            trailingEdge={paneState.trailingEdge}
            covering={covering}
            hidden={!thumbnail}
          />
        ) : rendered ? null : near ? (
          // The chat's header over its own flat surface, so the pane shows
          // whole, notch and tabs included, before the chat fills it.
          <ChatPaneStandIn target={target} />
        ) : (
          // Far off screen: only the chat's flat surface.
          <div aria-hidden className="min-h-0 min-w-0 flex-1 bg-background" />
        )}
      </LayoutPaneContext>
    </PanelAnimationSuppressionProvider>
  );
});

/**
 * A surface tab's slot: positioned like any pane, a press inside focuses it,
 * and focus that lands on it from the keyboard moves into it. It renders
 * while on screen and near the camera.
 */
function LayoutSurfaceTabSurface({
  tabId,
  content,
  placed,
  near,
  focused,
  atWindowStart,
  split,
  staged,
  overview,
  active,
}: {
  tabId: string;
  content: LayoutSurfaceContent;
  placed: { slot: LayoutPaneSlot; style: React.CSSProperties };
  near: boolean;
  focused: boolean;
  atWindowStart: boolean | undefined;
  split: boolean;
  staged: boolean;
  /** Under the overview: one not near draws its thumbnail. */
  overview: boolean;
  active: boolean;
}) {
  const { slot } = placed;
  const leadingEdge = atWindowStart ?? (!slot.hasLeft && !slot.hasAbove);
  const trailingEdge = !slot.hasRight && !slot.hasAbove;
  const paneState = {
    tabId,
    paneId: slot.paneId,
    split: split || staged,
    narrow: false,
    leadingEdge,
    trailingEdge,
    focused: focused && !staged,
    related: false,
    visible: active,
  } satisfies LayoutPaneState;
  const tab = { id: tabId, content } satisfies LayoutTab;
  const slotRef = useRef<HTMLDivElement | null>(null);
  // Focus that lands on the pane (cmd+J, alt+cmd+B, a launcher's letter, a
  // click on its tab) moves the keyboard in.
  usePaneKeyboard(slotRef, focused && !staged, surfaceKeyboardTarget);
  const claimFocus = () => {
    const store = useLayoutStore.getState();
    if (selectFocusedTab(store.layout)?.id !== tabId) store.focusTab(tabId);
  };
  return (
    <div
      ref={slotRef}
      tabIndex={-1}
      data-layout-tab-id={tabId}
      data-layout-pane-id={slot.paneId}
      data-layout-surface={content.surfaceId}
      data-layout-pane-focused={focused ? "true" : undefined}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col outline-none",
        (split || staged) && "overflow-clip rounded-pane pane-surface",
      )}
      style={placed.style}
      inert={staged}
      onPointerDownCapture={claimFocus}
    >
      <LayoutPaneContext value={paneState}>
        {near ? (
          <ThreadSurfaceTab threadRef={content.threadRef} surfaceId={content.surfaceId} />
        ) : overview ? (
          <PaneThumbnail
            tab={tab}
            paneId={slot.paneId}
            leadingEdge={leadingEdge}
            trailingEdge={trailingEdge}
          />
        ) : null}
      </LayoutPaneContext>
      {split && !staged ? <PaneCuts /> : null}
    </div>
  );
}

/** Where the keyboard goes in each kind of pane that takes layout focus. */
function chatKeyboardTarget(pane: HTMLElement): HTMLElement | null {
  return pane.querySelector<HTMLElement>("[contenteditable='true']");
}
function surfaceKeyboardTarget(pane: HTMLElement): HTMLElement {
  return pane.querySelector<HTMLElement>("textarea, input") ?? pane;
}
/** Settings takes the keyboard on the pane itself: focusing a field could start a shortcut recorder. */
function settingsKeyboardTarget(pane: HTMLElement): HTMLElement {
  return pane;
}
function launcherKeyboardTarget(pane: HTMLElement): HTMLElement | null {
  const launcher = pane.querySelector<HTMLElement>("[data-new-tab-launcher]");
  return launcher ? launcherFocusTarget(launcher) : null;
}

/** Release DOM focus immediately when layout focus leaves, even if the next pane is still rendering;
 * palette hand-back uses the same path. */
function usePaneKeyboard(
  paneRef: React.RefObject<HTMLElement | null>,
  focused: boolean,
  target: (pane: HTMLElement) => HTMLElement | null,
  handBack = true,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Transfer DOM focus and register keyboard handback for the committed focused pane.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    if (!focused) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && pane.contains(active)) active.blur();
      return;
    }
    moveDomFocusInto(pane, target(pane));
    if (!handBack) return;
    return holdFocusedPaneKeyboard(() => moveDomFocusInto(pane, target(pane), true));
  }, [focused, handBack, paneRef, target]);
}

/** Preserve focus held outside the strip unless explicitly handed back. An unready pane releases the
 * old keyboard target before it can receive more input. */
function moveDomFocusInto(pane: HTMLElement, target: HTMLElement | null, handedBack = false): void {
  if (pane.closest("[inert]")) return;
  const active = document.activeElement;
  if (pane.contains(active)) return;
  if (
    !handedBack &&
    active &&
    active !== document.body &&
    !active.closest('[data-layout-strip], [data-slot="menu-popup"]')
  ) {
    return;
  }
  target?.focus({ preventScroll: true });
  // A target that cannot take focus (hidden, disabled): the pane itself, if it can.
  if (!pane.contains(document.activeElement) && pane.hasAttribute("tabindex")) {
    pane.focus({ preventScroll: true });
  }
  if (!pane.contains(document.activeElement) && active instanceof HTMLElement) active.blur();
}

/**
 * The pane's corners where the strip's edge cuts it (index.css,
 * [data-pane-cut]). Render them last inside a positioned, clipped pane.
 */
function PaneCuts() {
  return (
    <>
      <span aria-hidden data-pane-cut="start-top" />
      <span aria-hidden data-pane-cut="start-notch" />
      <span aria-hidden data-pane-cut="start-bottom" />
      <span aria-hidden data-pane-cut="end-top" />
      <span aria-hidden data-pane-cut="end-notch">
        <span>
          <span />
        </span>
      </span>
      <span aria-hidden data-pane-cut="end-bottom" />
    </>
  );
}

/**
 * The focused workspace is an empty one, at the bottom of the stack or
 * (`top`) opened above it. It is one pane showing the launcher, as a lone
 * launcher tab would: a thread started there, or opened from the sidebar,
 * or a drop, lands here.
 */
function LayoutEmptyWorkspace({
  style,
  top,
  active,
}: {
  style: React.CSSProperties;
  top: boolean;
  /** The strip's own empty workspace, not one under the overview or mid-switch. */
  active: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Its surfaces open for the thread the URL still shows, if any.
  const routeTarget = useThreadRouteTarget();
  // The way back only means something while another workspace holds tabs.
  const othersHoldTabs = useLayoutStore((state) =>
    state.layout.workspaces.some((workspace) => workspace.columns.length > 0),
  );
  const back = othersHoldTabs
    ? shortcutLabelForCommand(
        keybindings,
        top ? "layout.focusWorkspaceDown" : "layout.focusWorkspaceUp",
      )
    : null;
  const overview = othersHoldTabs ? shortcutLabelForCommand(keybindings, "layout.overview") : null;
  const paneState = {
    tabId: null,
    paneId: null,
    split: !active,
    narrow: false,
    leadingEdge: true,
    trailingEdge: true,
    focused: active,
    related: false,
    visible: true,
  } satisfies LayoutPaneState;
  const paneRef = useRef<HTMLDivElement | null>(null);
  usePaneKeyboard(paneRef, active, launcherKeyboardTarget);
  return (
    <div
      ref={paneRef}
      data-layout-empty-workspace=""
      className={cn(
        "absolute flex flex-col",
        // Under the overview or mid-switch it draws its own pane, as panes do there.
        !active && "overflow-clip rounded-pane pane-surface",
      )}
      style={style}
      inert={!active}
    >
      <LayoutPaneContext value={paneState}>
        <LayoutLauncherPane
          tabId={null}
          context={routeTarget}
          footer={
            back || overview ? (
              <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-meta text-dim-foreground">
                {back ? `${back} goes back ${top ? "down" : "up"}.` : null}
                {back && overview ? " " : null}
                {overview ? `${overview} shows every workspace.` : null}
              </p>
            ) : null
          }
        />
      </LayoutPaneContext>
    </div>
  );
}

/**
 * A launcher tab's slot: positioned like any pane, a press inside focuses it.
 * It renders while on screen and near the camera; it holds nothing worth
 * keeping mounted.
 */
function LayoutLauncherSurface({
  tabId,
  context,
  placed,
  near,
  focused,
  atWindowStart,
  split,
  staged,
  closing = false,
}: {
  tabId: string;
  context: LayoutLauncherContent["context"];
  placed: { slot: LayoutPaneSlot; style: React.CSSProperties };
  /** Within a window of the camera; a launcher far off it draws its bare pane. */
  near: boolean;
  focused: boolean;
  atWindowStart: boolean | undefined;
  split: boolean;
  staged: boolean;
  /** Closed: a ghost sliding away, gone once its animation ends. */
  closing?: boolean;
}) {
  const { slot } = placed;
  const leadingEdge = atWindowStart ?? (!slot.hasLeft && !slot.hasAbove);
  const trailingEdge = !slot.hasRight && !slot.hasAbove;
  const paneState = {
    tabId,
    paneId: slot.paneId,
    split: split || staged,
    narrow: false,
    leadingEdge,
    trailingEdge,
    focused: focused && !staged,
    related: false,
    visible: true,
  } satisfies LayoutPaneState;
  const claimFocus = () => {
    const store = useLayoutStore.getState();
    if (selectFocusedTab(store.layout)?.id !== tabId) store.focusTab(tabId);
  };
  // Focus that lands on an open launcher (alt+cmd arrows, the overview) moves
  // the keyboard in; a new one takes it as it mounts (useLauncherElement).
  const launcherSlotRef = useRef<HTMLDivElement | null>(null);
  usePaneKeyboard(launcherSlotRef, focused && !staged && !closing, launcherKeyboardTarget);
  return (
    <div
      ref={launcherSlotRef}
      data-layout-tab-id={closing ? undefined : tabId}
      data-layout-pane-id={closing ? undefined : slot.paneId}
      data-layout-closing={closing ? tabId : undefined}
      data-layout-launcher=""
      data-layout-pane-focused={focused ? "true" : undefined}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        closing && "pointer-events-none",
        (split || staged) && "overflow-clip rounded-pane pane-surface",
      )}
      style={placed.style}
      inert={staged || closing}
      onPointerDownCapture={claimFocus}
    >
      <LayoutPaneContext value={paneState}>
        {near ? <LayoutLauncherPane tabId={tabId} context={context} /> : null}
      </LayoutPaneContext>
      {split && !staged ? <PaneCuts /> : null}
    </div>
  );
}

/**
 * Page tabs retain their real components and local URL when another pane
 * holds focus. A press inside focuses the tab and its URL follows.
 */
function LayoutPageSurface({
  tabId,
  placed,
  focused,
  atWindowStart,
  split,
  staged,
  children,
  active,
}: {
  tabId: string;
  placed: { slot: LayoutPaneSlot; style: React.CSSProperties } | null;
  focused: boolean;
  atWindowStart: boolean | undefined;
  split: boolean;
  staged: boolean;
  children: React.ReactNode;
  active: boolean;
}) {
  const slot = placed?.slot ?? FULL_SLOT;
  const visible = active && placed !== null;
  const leadingEdge = atWindowStart ?? (!slot.hasLeft && !slot.hasAbove);
  const trailingEdge = !slot.hasRight && !slot.hasAbove;
  const paneState = {
    tabId,
    paneId: slot.paneId,
    split,
    narrow: false,
    leadingEdge,
    trailingEdge,
    focused: focused && visible,
    related: false,
    visible,
  } satisfies LayoutPaneState;
  const settingsRef = useRef<HTMLDivElement | null>(null);
  usePaneKeyboard(settingsRef, focused && !staged, settingsKeyboardTarget);
  const claimFocus = () => {
    const store = useLayoutStore.getState();
    if (selectFocusedTab(store.layout)?.id !== tabId) store.focusTab(tabId);
  };
  return (
    <div
      ref={settingsRef}
      tabIndex={-1}
      data-layout-tab-id={tabId}
      data-layout-pane-id={slot.paneId}
      data-layout-page=""
      data-layout-pane-focused={focused ? "true" : undefined}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col outline-none",
        placed === null && "pointer-events-none inset-0 [content-visibility:hidden]",
        (split || staged) && "overflow-clip rounded-pane pane-surface",
      )}
      style={placed?.style}
      inert={!visible || staged}
      onPointerDownCapture={claimFocus}
    >
      <LayoutPaneContext value={paneState}>{children}</LayoutPaneContext>
      {split && !staged ? <PaneCuts /> : null}
    </div>
  );
}
