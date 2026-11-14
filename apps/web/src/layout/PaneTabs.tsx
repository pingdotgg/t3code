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
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useAtomValue } from "@effect/atom-react";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import {
  ArrowLeftIcon,
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
  useState,
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
import { useClientSettings } from "../hooks/useSettings";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { surfaceTabTitle, terminalTabTitle } from "./surfaceTabLabels";

const EMPTY_TABS: readonly LayoutTab[] = [];

/**
 * A pane's tab strip, one DOM node per pane that outlives its tabs' headers:
 * the shown tab's header portals its tabs into it and holds it in its row, so
 * a tab switch keeps the strip, its scroll and the joined tab shape, which
 * then moves to the new active tab (index.css, [data-pane-join]).
 */
interface PaneStrip {
  readonly strip: HTMLDivElement;
  readonly join: HTMLSpanElement;
  /** Where the joined shape sits or is heading, in the strip's scrolled content. */
  shown: { tabId: string | null; x: number; w: number } | null;
  /** The tab whose label reads as joined: the shape's, once it has landed there. */
  joinedId: string | null;
  /** The slide in flight, if any. */
  slide: Animation | null;
  /** The holding header's panel animation duration, for a slide begun on a press. */
  motionMs: number;
}

const paneStrips = new Map<string, PaneStrip>();
/** How the header holding a strip places its joined tab, with or without motion. */
const stripPlacers = new WeakMap<HTMLElement, (motionMs: number) => void>();
const stripEntries = new WeakMap<HTMLElement, PaneStrip>();
const pendingPlacements = new Map<HTMLElement, number>();
let placementFrame: number | null = null;

/**
 * Place a strip's joined tab in the next frame, before it paints: reading the
 * tabs' boxes inside a tab switch's commit would lay the incoming chat out
 * there and again once the commit's other effects had run.
 */
function schedulePlacement(strip: HTMLElement, motionMs: number): void {
  pendingPlacements.set(strip, Math.max(motionMs, pendingPlacements.get(strip) ?? 0));
  placementFrame ??= requestAnimationFrame(() => {
    placementFrame = null;
    const placements = [...pendingPlacements];
    pendingPlacements.clear();
    for (const [pending, motion] of placements) stripPlacers.get(pending)?.(motion);
  });
}

const PANE_JOIN_RADIUS_PX = 10;
const PANE_JOIN_EAR_PX = 10;
const PANE_JOIN_TAIL_PX = 36;
/** The strip's edge fade (index.css), which the revealed tab's ears stay clear of. */
const PANE_STRIP_FADE_PX = 24;

function joinPiece(name: string, value = ""): HTMLElement {
  const piece = document.createElement("i");
  piece.setAttribute(name, value);
  return piece;
}

function joinCap(side: "l" | "r"): HTMLElement {
  const cap = joinPiece("data-jc", side);
  cap.append(
    joinPiece("data-jf"),
    joinPiece("data-jr"),
    joinPiece("data-je"),
    joinPiece("data-jer"),
    joinPiece("data-jt"),
  );
  return cap;
}

function createPaneStrip(): PaneStrip {
  const strip = document.createElement("div");
  strip.dataset.layoutTabStrip = "";
  strip.className =
    "relative flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
  // The joined tab: two caps (corner, side, ear, rim) and a middle that
  // scales, so it moves by transform alone; the pill shows it unfocused.
  const join = document.createElement("span");
  join.dataset.paneJoin = "";
  join.setAttribute("aria-hidden", "true");
  join.hidden = true;
  const body = joinPiece("data-jb");
  body.append(joinCap("l"), joinPiece("data-jm"), joinCap("r"));
  join.append(body, joinPiece("data-jp"));
  strip.append(join);
  const entry: PaneStrip = { strip, join, shown: null, joinedId: null, slide: null, motionMs: 0 };
  stripEntries.set(strip, entry);
  strip.addEventListener(
    "wheel",
    (event) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
        strip.scrollWidth <= strip.clientWidth
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      strip.scrollLeft += wheelDeltaPx(event.deltaY, event);
    },
    { passive: false },
  );
  strip.addEventListener("scroll", () => markStripOverflow(strip), { passive: true });
  // The shape leaves on the press, before the switch's render: a click lands
  // on its release, after the incoming chat has been laid out.
  strip.addEventListener("pointerdown", (event) => slideOnPress(entry, event));
  setWheelScroller(strip, () => strip.scrollWidth > strip.clientWidth);
  // A tab opening, closing or changing size moves the others without a render here.
  // Not observeResize: no React state changes, and its flushSync would force the
  // incoming chat's pending render into the tab switch's task.
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- Places a DOM node only; see above.
  const resize = new ResizeObserver(() => {
    stripPlacers.get(strip)?.(0);
    markStripOverflow(strip);
  });
  resize.observe(strip);
  new MutationObserver(() => {
    for (const tab of strip.querySelectorAll(":scope > [data-strip-layer] > *")) {
      resize.observe(tab);
    }
    // A tab rendered again (a header swap) reads as joined from its first frame.
    markJoinedLabel(entry);
    schedulePlacement(strip, 0);
  }).observe(strip, { childList: true, subtree: true });
  return entry;
}

/** How much of the strip is scrolled out at each end, for its edge fade. */
function markStripOverflow(strip: HTMLElement): void {
  const end = strip.scrollWidth - strip.clientWidth - strip.scrollLeft;
  strip.style.setProperty("--strip-overflow-start", `${Math.max(0, strip.scrollLeft)}px`);
  strip.style.setProperty("--strip-overflow-end", `${Math.max(0, end)}px`);
  strip.style.setProperty("--strip-overflowing-end", end > 0.5 ? "1" : "0");
}

function paneStripFor(key: string): PaneStrip {
  let entry = paneStrips.get(key);
  if (!entry) {
    entry = createPaneStrip();
    paneStrips.set(key, entry);
  }
  return entry;
}

/** The shown header places the strip's joined tab, with its own motion setting. */
function holdPaneStrip(
  entry: PaneStrip,
  place: (motionMs: number) => void,
  motionMs: number,
): void {
  stripPlacers.set(entry.strip, place);
  entry.motionMs = motionMs;
  schedulePlacement(entry.strip, motionMs);
}

/** Forget a pane's strip once no header holds it, after the commit that may hand it on. */
function releasePaneStrip(key: string, entry: PaneStrip): void {
  queueMicrotask(() => {
    if (entry.strip.isConnected || paneStrips.get(key) !== entry) return;
    setWheelScroller(entry.strip, null);
    paneStrips.delete(key);
  });
}

/** A header's tabs: in the pane's strip while its header shows, hidden in its own row otherwise. */
function showStripLayer(layer: HTMLElement, parent: HTMLElement, shown: boolean): void {
  layer.style.display = shown ? "contents" : "none";
  if (layer.parentNode !== parent) moveInto(parent, layer);
}

function moveInto(parent: HTMLElement, node: HTMLElement): void {
  // moveBefore keeps the node's scroll and running transitions where it exists.
  const atomic = (parent as { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
  if (atomic && node.isConnected) atomic.call(parent, node, null);
  else parent.append(node);
}

const PANE_JOIN_EASING = "ease-out";
const STRIP_TAB_SELECTOR = "[data-layout-pane-tab], [data-tab-key]";

/** A layout tab by its id, or a panel's own tab (RightPanelTabs) by its surface. */
function stripTabId(tab: HTMLElement): string | null {
  return tab.dataset.layoutPaneTab ?? tab.dataset.tabKey ?? null;
}

function findStripTab(strip: HTMLElement, tabId: string | null): HTMLElement | null {
  if (tabId === null) return null;
  return (
    [...strip.querySelectorAll<HTMLElement>("[data-layout-pane-tab]")].find(
      (candidate) => candidate.dataset.layoutPaneTab === tabId,
    ) ?? null
  );
}

/** The label under the landed shape reads as the active one (index.css, [data-joined]). */
function markJoinedLabel(entry: PaneStrip): void {
  for (const tab of entry.strip.querySelectorAll<HTMLElement>(STRIP_TAB_SELECTOR)) {
    const joined = entry.joinedId !== null && stripTabId(tab) === entry.joinedId;
    if (tab.hasAttribute("data-joined") !== joined) tab.toggleAttribute("data-joined", joined);
  }
}

function stripBoxOf(strip: HTMLElement, tab: HTMLElement): { x: number; w: number } | null {
  const bounds = strip.getBoundingClientRect();
  // Layout pixels, also while the overview scales the pane.
  const scale = strip.offsetWidth > 0 ? bounds.width / strip.offsetWidth : 1;
  if (scale <= 0) return null;
  const rect = tab.getBoundingClientRect();
  return {
    x: Math.round((rect.left - bounds.left) / scale + strip.scrollLeft),
    w: Math.round(rect.width / scale),
  };
}

/**
 * Put the joined shape on a tab, sliding there from where it is when motion
 * is on, transform only. The label switches when the shape lands.
 */
function moveJoin(
  entry: PaneStrip,
  to: { tabId: string | null; x: number; w: number },
  motionMs: number,
): void {
  const { join } = entry;
  const was = entry.shown;
  // Already heading there (a slide begun on the press): let it land.
  if (entry.slide && was?.tabId === to.tabId && was.x === to.x && was.w === to.w) return;
  entry.shown = to;
  join.hidden = false;
  const middle = (width: number) => Math.max(0, width - 2 * PANE_JOIN_RADIUS_PX);
  join.style.setProperty("--jx", `${to.x}px`);
  join.style.setProperty("--jw", `${to.w}px`);
  join.style.setProperty("--jm", String(middle(to.w)));
  const land = () => {
    entry.slide = null;
    entry.joinedId = to.tabId;
    markJoinedLabel(entry);
  };
  // Under black chrome and on phones the notch draws the tab and no shape shows.
  if (!was || motionMs <= 0 || join.getClientRects().length === 0) {
    entry.slide?.cancel();
    land();
    return;
  }
  // From where the shape is drawn now, mid-slide included.
  const capBox = join.querySelector('[data-jc="l"]')?.getBoundingClientRect();
  const stripBox = entry.strip.getBoundingClientRect();
  const fromX =
    entry.slide && capBox
      ? Math.round(capBox.left - stripBox.left + entry.strip.scrollLeft + PANE_JOIN_EAR_PX)
      : was.x;
  const from = { x: fromX, w: was.w };
  entry.slide?.cancel();
  const timing = { duration: motionMs, easing: PANE_JOIN_EASING };
  const r = PANE_JOIN_RADIUS_PX;
  const e = PANE_JOIN_EAR_PX;
  const piece = (selector: string) => join.querySelector<HTMLElement>(selector);
  for (const animation of join.getAnimations({ subtree: true })) animation.cancel();
  piece('[data-jc="l"]')?.animate(
    [{ translate: `${from.x - e}px 0` }, { translate: `${to.x - e}px 0` }],
    timing,
  );
  piece('[data-jc="r"]')?.animate(
    [{ translate: `${from.x + from.w - r - 1}px 0` }, { translate: `${to.x + to.w - r - 1}px 0` }],
    timing,
  );
  const slide = piece("[data-jm]")?.animate(
    [
      { translate: `${from.x + r}px 0`, scale: `${middle(from.w) / Math.max(1, middle(to.w))} 1` },
      { translate: `${to.x + r}px 0`, scale: "1 1" },
    ],
    timing,
  );
  if (!slide) {
    land();
    return;
  }
  entry.slide = slide;
  void slide.finished.then(
    () => {
      if (entry.slide === slide) land();
    },
    () => {},
  );
}

/** Place the joined shape under the header's active tab. Reads layout once. */
function placePaneJoin(entry: PaneStrip, tabId: string | null, motionMs: number): void {
  const { strip, join } = entry;
  const active =
    findStripTab(strip, tabId) ?? strip.querySelector<HTMLElement>("[data-active-tab='true']");
  if (!active) {
    join.hidden = true;
    entry.shown = null;
    entry.joinedId = null;
    markJoinedLabel(entry);
    return;
  }
  const box = stripBoxOf(strip, active);
  if (!box) return;
  const activeId = stripTabId(active);
  // Only a change of tab moves it; a tab growing or the strip scrolling places it.
  moveJoin(entry, { tabId: activeId, ...box }, entry.shown?.tabId === activeId ? 0 : motionMs);
}

/**
 * A press on another tab sends the shape there at once. A press that does
 * not end in that tab showing (a drag, a press that slides off) brings the
 * shape back once the release has been handled.
 */
function slideOnPress(entry: PaneStrip, event: PointerEvent): void {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
    return;
  if (!(event.target instanceof Element) || event.target.closest("[data-tab-close]")) return;
  const tab = event.target.closest<HTMLElement>(STRIP_TAB_SELECTOR);
  if (!tab || !entry.strip.contains(tab)) return;
  const tabId = stripTabId(tab);
  if (tabId === null || tabId === entry.shown?.tabId) return;
  const box = stripBoxOf(entry.strip, tab);
  if (!box) return;
  moveJoin(entry, { tabId, ...box }, entry.motionMs);
  const settle = () => {
    window.removeEventListener("pointerup", settle, true);
    window.removeEventListener("pointercancel", settle, true);
    window.setTimeout(() => schedulePlacement(entry.strip, entry.motionMs), 0);
  };
  window.addEventListener("pointerup", settle, true);
  window.addEventListener("pointercancel", settle, true);
}

/** Reveal the active tab in a strip wider than its pane, keeping the joined tab's ears inside. */
function revealPaneTab(strip: HTMLElement, tabId: string | null): void {
  const tab = findStripTab(strip, tabId);
  if (!tab) return;
  const bounds = strip.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  // Room for the joined tab's ears inside the strip's clip, and at the end for
  // its rim's tail, which the next control on the bar overlaps.
  const start = bounds.left + PANE_JOIN_EAR_PX + PANE_STRIP_FADE_PX;
  const end = bounds.right - PANE_JOIN_EAR_PX - PANE_JOIN_TAIL_PX;
  // A file tab's trailing breadcrumb names the file; reveal it before its thread label.
  if (rect.width > end - start && tab.dataset.layoutTabReveal === "end")
    strip.scrollLeft += rect.right - end;
  else if (rect.left < start) strip.scrollLeft -= start - rect.left;
  else if (rect.right > end) strip.scrollLeft += rect.right - end;
}

/**
 * Keep overflow reachable by wheel and touch, and reveal the selected tab
 * without moving its pane. Inside a layout pane the strip is the pane's own
 * (see PaneStrip); `role` names a second strip in the same pane.
 */
export function LayoutPaneTabStrip({
  children,
  role,
}: {
  children: ReactNode;
  role?: "panel" | undefined;
}) {
  const { tabId, paneId, visible } = useLayoutPane();
  const key = paneId === null ? null : role ? `${paneId}:${role}` : paneId;
  const [own] = useState(() => (key === null ? createPaneStrip() : null));
  const entry = own ?? paneStripFor(key!);
  const holds = own !== null || visible;
  const motionMs = usePaneJoinMotionMs();
  const slotRef = useRef<HTMLSpanElement>(null);
  // This header's tabs. They stay mounted while the header is hidden, as a
  // hidden tab's whole header does; only the shown header's layer sits in the
  // pane's strip.
  const [layer] = useState(() => {
    const element = document.createElement("div");
    element.dataset.stripLayer = "";
    element.style.display = "contents";
    return element;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hold the pane's persistent strip node in this header's row and place its joined tab after each commit.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const { strip } = entry;
    if (!holds) {
      showStripLayer(layer, slot, false);
      return;
    }
    if (strip.parentNode !== slot) moveInto(slot, strip);
    showStripLayer(layer, strip, true);
    const place = (motion: number) => {
      revealPaneTab(strip, tabId);
      placePaneJoin(entry, tabId, motion);
    };
    holdPaneStrip(entry, place, motionMs);
  }, [entry, holds, layer, motionMs, tabId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Take this header's tabs out of the pane's strip, and drop the strip once its last header lets go of it.
  useLayoutEffect(
    () => () => {
      layer.remove();
      if (key !== null) releasePaneStrip(key, entry);
    },
    [entry, key, layer],
  );
  return (
    <>
      <span ref={slotRef} data-layout-tab-strip-slot="" className="contents" />
      {createPortal(children, layer)}
    </>
  );
}

/**
 * The panel animation duration for the joined tab, or 0 when panel motion is
 * off. Not usePanelAnimationSettings: its route suppression holds every tab
 * switch, which navigates, and the tab's slide is that switch's only motion.
 */
function usePaneJoinMotionMs(): number {
  const durationMs = useClientSettings((settings) => settings.panelAnimationDurationMs);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  return reducedMotion ? 0 : durationMs;
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
 * The way back from a child thread to its parent, ahead of the child tabs: a
 * muted arrow and the parent's title, so it reads as navigation, not a tab.
 */
export function ParentThreadLinkLabel({ title }: { title: string }) {
  return (
    <>
      <ArrowLeftIcon aria-hidden className="size-3.5 shrink-0" />
      <span className={PANE_INACTIVE_TAB_TITLE_CLASS} dir={textDirection(title)}>
        {title}
      </span>
    </>
  );
}

/**
 * An inactive pane tab (pen W6VyO): click shows it, middle click or its close
 * button closes it, right click opens its menu, dragging moves or splits it.
 * As the active thread's parent (`parentLink`) it draws as a back link and keeps every handler.
 */
export const LayoutPaneTab = memo(function LayoutPaneTab({
  tab,
  parentLink = false,
}: {
  tab: LayoutTab;
  parentLink?: boolean;
}) {
  if (tab.content.kind === "chat" && tab.content.target.kind === "server") {
    return (
      <ThreadLayoutPaneTab
        tab={tab}
        threadRef={tab.content.target.threadRef}
        parentLink={parentLink}
      />
    );
  }
  return <PlainLayoutPaneTab tab={tab} />;
});

function PlainLayoutPaneTab({ tab }: { tab: LayoutTab }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return (
    <LayoutPaneTabButton
      tab={tab}
      parentLink={false}
      onOpenMenu={(position) => void showLayoutTabMenu(tab.id, position, keybindings)}
    />
  );
}

function ThreadLayoutPaneTab({
  tab,
  threadRef,
  parentLink,
}: {
  tab: LayoutTab;
  threadRef: ScopedThreadRef;
  parentLink: boolean;
}) {
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
  return <LayoutPaneTabButton tab={tab} parentLink={parentLink} onOpenMenu={openMenu} />;
}

function LayoutPaneTabButton({
  tab,
  parentLink,
  onOpenMenu,
}: {
  tab: LayoutTab;
  parentLink: boolean;
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
              aria-label={parentLink ? `Back to parent thread: ${label.title}` : undefined}
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
          {parentLink ? (
            <ParentThreadLinkLabel title={label.title} />
          ) : (
            <>
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
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="whitespace-pre-line">
          {parentLink ? `${label.title}\nParent thread` : label.tooltip}
        </TooltipPopup>
      </Tooltip>
      {/* A back link has no close button; middle click and its menu still close the tab. */}
      {parentLink ? null : <LayoutTabCloseButton tabId={tab.id} title={label.title} />}
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
  const lineageIcon = <GitForkIcon aria-hidden className="size-3.5 shrink-0" />;
  if (tab.ghostOf) {
    return { icon: lineageIcon, title, tooltip: ghostTabTooltip(title, ghostParent?.title) };
  }
  // A subagent opened any other way (a thread mention, a kept tab) keeps the same icon.
  const icon =
    thread?.lineage.relationshipToParent === "subagent" ? (
      lineageIcon
    ) : draftId !== null ? (
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
