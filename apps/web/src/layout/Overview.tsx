/**
 * Zoom the live workspace stage with one compositor transform; never render a stand-in.
 * Mount other workspaces at full size before measuring, then trim keep-alive after closing.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { shortcutLabelForCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { findInOpenLayers } from "../lib/openLayers";
import { isModalDialogOpen } from "../lib/modalDialog";
import { cn, isMacPlatform } from "../lib/utils";
import { useStableCallback } from "../hooks/useStableCallback";
import { registerCommands } from "../shortcuts/dispatcher";
import { MotionAnimation, playMotion, type MotionRun } from "../motion/animation";
import { settleStripCamera } from "../motion/stripCamera";
import { finishWorkspaceSwitch } from "../motion/workspaceSwitch";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { useLayoutTabLabel } from "./PaneTabs";
import {
  findLayoutTab,
  selectFocusedTab,
  selectLayoutPaneSlots,
  type LayoutDirection,
  type LayoutPaneSlot,
  type LayoutState,
  type LayoutTab,
  type LayoutViewport,
  type LayoutWorkspace,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { observeResize } from "../lib/observeResize";

/** The largest share of the window a window-wide pane takes zoomed out (pen: 464px for 1280). */
const OVERVIEW_SCALE = 0.3625;
/** Widest share of the window a zoomed-out row may take. */
const OVERVIEW_MAX_ROW_SHARE = 0.92;
/** Space between workspace rows on screen (pen: 276px pitch for 252px rows). */
const ROW_GAP = 24;
/** Pointer travel before a press on a pane becomes a drag. */
const DRAG_THRESHOLD = 6;
/** Resting in the hot corner this long opens the overview. */
const HOT_CORNER_DWELL_MS = 250;
/** Pinch travel that opens the overview or closes it beyond full pane size. */
const PINCH_THRESHOLD = 40;
/** Manual zoom ranges from a quarter of the fitted view up to full pane size. */
const MIN_ZOOM_SHARE = 0.25;
const WHEEL_ZOOM_RATE = 0.002;
/** A wheel event this soon after the last one continues the same scroll or pinch. */
const WHEEL_STREAM_GAP_MS = 150;
/** The zoom's spring (overview-open-close) as a CSS transition's length and curve. */
function zoomTiming(): { durationMs: number; easing: string } {
  const motion = MotionAnimation.start("overview-open-close", 0, 1);
  return { durationMs: motion.durationMs, easing: motion.cssEasing() };
}

/** The backdrop and hint fade with the zoom. */
export function overviewZoomTransition(): React.CSSProperties {
  const { durationMs, easing } = zoomTiming();
  return { transitionDuration: `${durationMs}ms`, transitionTimingFunction: easing };
}

const OVERVIEW_KEYS: Readonly<Record<string, LayoutDirection>> = {
  h: "left",
  ArrowLeft: "left",
  l: "right",
  ArrowRight: "right",
  j: "down",
  ArrowDown: "down",
  k: "up",
  ArrowUp: "up",
};

// Keep the stage mounted through both zooms.
// The opening phase measures full-size panes before scaling, since virtual lists read rects.

export type OverviewPhase = "closed" | "opening" | "open" | "closing";

let phase: OverviewPhase = "closed";
/**
 * Where the strip was scrolled, which workspace it showed, and how far a
 * workspace switch in flight had carried it (in rows), when the overview opened.
 */
let entry = { scrollLeft: 0, workspaceId: "", rowOffset: 0 };
const phaseListeners = new Set<() => void>();
// The existing background handler and gesture listener share the mounted stage.
let overviewCamera: {
  pan: (x: number, y: number) => void;
  /** Returns outward travel past maximum zoom, as a scale factor. */
  zoom: (factor: number, x: number, y: number) => number;
} | null = null;
// The background pan or pane drag in progress, ended (without its drop) when
// another starts, the window blurs or the overview leaves open.
let stopOverviewGesture: (() => void) | null = null;

function holdOverviewGesture(stop: () => void): void {
  stopOverviewGesture = stop;
}

function releaseOverviewGesture(stop: () => void): void {
  if (stopOverviewGesture === stop) stopOverviewGesture = null;
}

function setPhase(next: OverviewPhase): void {
  if (phase === next) return;
  if (next === "closing" || next === "closed") stopOverviewGesture?.();
  phase = next;
  for (const listener of phaseListeners) listener();
}

function subscribePhase(listener: () => void): () => void {
  phaseListeners.add(listener);
  return () => {
    phaseListeners.delete(listener);
  };
}

/** Whether the stage shows: open, or zooming back in. */
export function useOverviewPhase(): OverviewPhase {
  return useSyncExternalStore(subscribePhase, () => phase);
}

/**
 * Keys and clicks work from the keypress on, not while zooming back in.
 * The camera (wheel, pinch, drag) waits for the zoom to land: see `move`.
 */
function isOverviewInteractive(): boolean {
  return !isModalDialogOpen() && (phase === "open" || phase === "opening");
}

function setOverviewOpen(open: boolean) {
  useLayoutStore.getState().setOverviewOpen(open);
}

export function LayoutOverview() {
  useOverviewGestures();
  // Runs inside the store's set, before React renders the stage: the strip
  // still has its scroll position here, and loses it once the stage lays out.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Capture the DOM scroll frame before the external layout store opens the overview.
  useEffect(
    () =>
      useLayoutStore.subscribe((state, previous) => {
        if (state.overviewOpen === previous.overviewOpen) return;
        if (!state.overviewOpen) {
          if (phase === "open" || phase === "opening") setPhase("closing");
          return;
        }
        if (phase === "closed") {
          // The zoom starts from what the window shows, mid-motion included.
          settleStripCamera();
          const handoff = finishWorkspaceSwitch();
          const strip = document.querySelector<HTMLElement>("[data-layout-strip]");
          if (strip) pinOverviewFrame(strip);
          entry = {
            scrollLeft: handoff.scrollLeft ?? strip?.scrollLeft ?? 0,
            workspaceId: state.layout.focusedWorkspaceId,
            rowOffset: handoff.rowOffset,
          };
          // The panes go inert under the overview; keys belong to it now.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        }
        // Reopened mid-close too: "open" only once the zoom out lands.
        setPhase("opening");
      }),
    [],
  );
  useOverviewKeys();
  const phaseNow = useOverviewPhase();
  const open = phaseNow === "open" || phaseNow === "opening";
  return (
    <>
      <LayoutHotCorner />
      {open ? <OverviewCloseHint /> : null}
    </>
  );
}

/**
 * Open the focused pane (or `tabId`'s) and zoom into it. Off a thread route
 * (settings, say) the overview has no thread behind it, so opening a pane
 * also navigates there; on a thread route the URL already follows focus.
 */
function useChooseOverviewTab(): (tabId: string | null) => void {
  const navigate = useNavigate();
  const onThreadRoute = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params) !== null,
  });
  return (tabId) => {
    const store = useLayoutStore.getState();
    const before = selectFocusedTab(store.layout);
    if (tabId !== null) store.focusTab(tabId);
    const layout = useLayoutStore.getState().layout;
    const focused = selectFocusedTab(layout);
    // The route sync navigates on its own when a chat tab took focus.
    const routeSyncNavigates =
      focused !== null && focused.id !== before?.id && focused.content.kind === "chat";
    if (!onThreadRoute && focused && !routeSyncNavigates) {
      const chat = focused;
      const target = chat?.content.kind === "chat" ? chat.content.target : null;
      if (target?.kind === "server") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target.threadRef),
        });
      } else if (target?.kind === "draft") {
        void navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(target.draftId),
        });
      }
    }
    setOverviewOpen(false);
  };
}

/** Overview focus changes are real and update the URL. Leave typing and Escape to any palette or
 * dialog opened above the overview. */
function useOverviewKeys(): void {
  const choose = useChooseOverviewTab();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Route overview navigation keys only while its host is mounted.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isOverviewInteractive() || event.defaultPrevented) return;
      if (isCommandPaletteOpen() || isModalDialogOpen()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const direction = OVERVIEW_KEYS[event.key];
      // The overview owns the keyboard: other text goes nowhere, not into the
      // composer behind it, and Tab does not walk the sidebar under it.
      const text = event.key.length === 1 && !isEditableFocused(event.target);
      const owned = event.key === "Escape" || event.key === "Enter" || event.key === "Tab";
      if (!owned && !direction && !text) return;
      event.preventDefault();
      event.stopPropagation();
      if (direction) useLayoutStore.getState().focusDirection(direction);
      else if (event.key === "Enter") choose(null);
      else if (event.key === "Escape") setOverviewOpen(false);
    };
    return registerCommands(
      {},
      {
        capture: true,
        onKeyDown: (event) => {
          onKeyDown(event);
          return event.defaultPrevented;
        },
      },
    );
  }, [choose]);
}

/** The hint row's height, which the stage keeps clear; read on every wheel step. */
function closeHintHeight(): number {
  return findInOpenLayers("[data-overview-close-hint]")?.clientHeight ?? 0;
}

function OverviewCloseHint() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const closeKey = shortcutLabelForCommand(keybindings, "layout.overview");
  // The layout focus keys move the selection too ("Alt+Shift+Left" reads as
  // "Alt+Shift+arrows"); a rebinding off the arrows is left unnamed.
  const focusKey = shortcutLabelForCommand(keybindings, "layout.focusLeft");
  const focusModifiers = focusKey?.endsWith("Left") ? focusKey.slice(0, -"Left".length) : null;
  const focusArrows = focusModifiers
    ? `${focusModifiers}${focusModifiers.endsWith("+") ? "" : " "}arrows`
    : null;
  return createPortal(
    <div
      // Its own row of window chrome (black chrome tokens too), above the stage,
      // so a workspace below the focused one never runs under the text. As tall
      // as the top chrome row, so the text centers on the footer line.
      data-chrome-scope=""
      data-overview-close-hint=""
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex h-(--workspace-chrome-row-height) items-center justify-center bg-(--app-chrome-background) text-meta text-dim-foreground motion-safe:transition-opacity motion-safe:starting:opacity-0"
      style={overviewZoomTransition()}
    >
      {focusArrows ? `hjkl, arrows or ${focusArrows}` : "hjkl or arrows"} to move, Enter to open,{" "}
      {closeKey ? `${closeKey} or ` : ""}Esc to close
    </div>,
    document.body,
  );
}

/**
 * The bottom-left corner of the window. The top-left holds the traffic
 * lights and the top-right the window controls off macOS, so the bottom
 * left is the one corner nothing else claims.
 */
function LayoutHotCorner() {
  const timer = useRef<number | null>(null);
  const cancel = useStableCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel the pending hot-corner timer when its target unmounts.
  useEffect(() => cancel, [cancel]);
  return (
    <div
      aria-hidden
      data-layout-hot-corner=""
      className="fixed bottom-0 left-0 z-50 size-1"
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse" || event.buttons !== 0) return;
        cancel();
        timer.current = window.setTimeout(() => {
          timer.current = null;
          setOverviewOpen(true);
        }, HOT_CORNER_DWELL_MS);
      }}
      onPointerLeave={cancel}
    />
  );
}

/** Mac pinch entry stays available while closed; open-wheel handling belongs to the camera. */
function useOverviewGestures(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own native wheel and pinch gesture subscriptions for the layout overview.
  useEffect(() => {
    if (!isMacPlatform(navigator.platform)) return;
    let travel = 0;
    let resetTimer: number | null = null;
    let gestureScale = 1;
    let gestureOverflow = 1;
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || isModalDialogOpen() || isOverviewInteractive()) return;
      if (!event.ctrlKey || Number.isInteger(event.deltaY)) return;
      event.preventDefault();
      travel += event.deltaY;
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        resetTimer = null;
        travel = 0;
      }, 200);
      if (!useLayoutStore.getState().overviewOpen && travel > PINCH_THRESHOLD) {
        travel = 0;
        setOverviewOpen(true);
      }
    };
    // Safari's GestureEvent is not in the DOM typings; its scale is cumulative.
    const startGesture = (event: Event) => {
      if (isModalDialogOpen()) return;
      event.preventDefault();
      gestureScale = 1;
      gestureOverflow = 1;
    };
    const onGesture = (event: Event) => {
      if (isModalDialogOpen()) return;
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const scale = gesture.scale ?? 1;
      if (scale <= 0) return;
      const factor = scale / gestureScale;
      gestureScale = scale;
      if (isOverviewInteractive()) {
        const overflow = overviewCamera?.zoom(
          factor,
          gesture.clientX ?? window.innerWidth / 2,
          gesture.clientY ?? window.innerHeight / 2,
        );
        gestureOverflow = factor > 1 ? gestureOverflow * (overflow ?? 1) : 1;
        if (gestureOverflow > 1.25) {
          gestureOverflow = 1;
          setOverviewOpen(false);
        }
      } else if (!useLayoutStore.getState().overviewOpen && scale < 0.8) {
        setOverviewOpen(true);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("gesturestart", startGesture, { passive: false });
    window.addEventListener("gesturechange", onGesture, { passive: false });
    window.addEventListener("gestureend", startGesture, { passive: false });
    return () => {
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("gesturestart", startGesture);
      window.removeEventListener("gesturechange", onGesture);
      window.removeEventListener("gestureend", startGesture);
    };
  }, []);
}

// The stage: every workspace laid out at full size, one row per workspace,
// in units of the strip's own box. The zoom only transforms it.

export interface OverviewRow {
  workspace: LayoutWorkspace;
  /** Row position in the stack, from the top. */
  index: number;
  stripWidth: number;
  slots: LayoutPaneSlot[];
}

export interface OverviewStageLayout {
  rows: OverviewRow[];
  focusedRow: OverviewRow;
  scale: number;
  /** Unscaled px between rows, so `ROW_GAP` shows on screen. */
  gap: number;
}

/**
 * `windowWidth` is the window's px width; `viewport.width` the strip's, the
 * unit rows are laid out in. The scale keeps on-screen sizes window relative.
 */
export function selectOverviewStage(
  layout: LayoutState,
  viewport: LayoutViewport,
  windowWidth: number,
): OverviewStageLayout {
  // An empty workspace only shows while it is the focused one.
  const rows = layout.workspaces
    .filter(
      (workspace) => workspace.columns.length > 0 || workspace.id === layout.focusedWorkspaceId,
    )
    .map((workspace, index) => ({
      workspace,
      index,
      ...selectLayoutPaneSlots(workspace, viewport),
    }));
  const widest = Math.max(1, ...rows.map((row) => row.stripWidth));
  const toWindow = viewport.width > 0 ? windowWidth / viewport.width : 1;
  const scale = Math.min(OVERVIEW_SCALE, OVERVIEW_MAX_ROW_SHARE / widest) * toWindow;
  const focusedRow = rows.find((row) => row.workspace.id === layout.focusedWorkspaceId) ?? rows[0]!;
  return { rows, focusedRow, scale, gap: ROW_GAP / scale };
}

/** Rows are centered on the stage; a row wider than the window starts left of it. */
function rowLeftShare(row: OverviewRow): number {
  return (1 - row.stripWidth) / 2;
}

function rowBox(row: OverviewRow, gap: number): React.CSSProperties {
  return {
    left: `${rowLeftShare(row) * 100}%`,
    top: `calc(${row.index * 100}% + ${row.index * gap}px)`,
    width: `${row.stripWidth * 100}%`,
    height: "100%",
  };
}

/** A pane's box on the stage; `edge` is the half gap on each side with a neighbor. */
export function overviewSlotStyle(
  row: OverviewRow,
  slot: LayoutPaneSlot,
  gap: number,
  edge: string,
): React.CSSProperties {
  const side = (has: boolean) => (has ? edge : "0px");
  const left = rowLeftShare(row) + slot.rect.left * row.stripWidth;
  return {
    left: `calc(${left * 100}% + ${side(slot.hasLeft)})`,
    top: `calc(${(row.index + slot.rect.top) * 100}% + ${row.index * gap}px + ${side(slot.hasAbove)})`,
    width: `calc(${slot.rect.width * row.stripWidth * 100}% - ${side(slot.hasLeft)} - ${side(slot.hasRight)})`,
    height: `calc(${slot.rect.height * 100}% - ${side(slot.hasAbove)} - ${side(slot.hasBelow)})`,
  };
}

/**
 * Where the strip will scroll when the overview zooms into `row`: where it
 * was if that workspace was on screen, moved just enough to show its
 * focused pane.
 */
function exitScrollLeft(row: OverviewRow, width: number): number {
  const stripPx = row.stripWidth * width;
  let scroll = row.workspace.id === entry.workspaceId ? entry.scrollLeft : 0;
  const slot = row.slots.find((candidate) => candidate.paneId === row.workspace.focusedPaneId);
  if (slot) {
    const left = slot.rect.left * stripPx;
    const right = left + slot.rect.width * stripPx;
    if (left < scroll) scroll = left;
    else if (right > scroll + width) scroll = Math.min(left, right - width);
  }
  return Math.max(0, Math.min(stripPx - width, scroll));
}

interface StageTransform {
  x: number;
  y: number;
  scale: number;
}

/** The stage as the window shows it outside the overview: `row` scrolled to `scroll`. */
function zoomedIn(stage: OverviewStageLayout, row: OverviewRow, scroll: number, box: DOMRect) {
  return {
    x: -(rowLeftShare(row) * box.width + scroll),
    y: -(row.index * (box.height + stage.gap)),
    scale: 1,
  };
}

/** The stage zoomed out, the focused row centered in the window. */
function zoomedOut(stage: OverviewStageLayout, box: DOMRect, scale = stage.scale): StageTransform {
  const row = stage.focusedRow;
  const slot =
    scale === stage.scale
      ? null
      : row.slots.find((candidate) => candidate.paneId === row.workspace.focusedPaneId);
  const centerX = slot
    ? (rowLeftShare(row) + (slot.rect.left + slot.rect.width / 2) * row.stripWidth) * box.width
    : box.width / 2;
  const rowCenter =
    row.index * (box.height + stage.gap) +
    (slot ? slot.rect.top + slot.rect.height / 2 : 0.5) * box.height;
  return {
    x: window.innerWidth / 2 - box.left - scale * centerX,
    y: window.innerHeight / 2 - box.top - scale * rowCenter,
    scale,
  };
}

/** Reach either end of the real rows without panning the entire stage out of view. */
function boundOverviewTransform(
  stage: OverviewStageLayout,
  box: DOMRect,
  transform: StageTransform,
  footerHeight: number,
): StageTransform {
  const widest = Math.max(1, ...stage.rows.map((row) => row.stripWidth));
  const bound = (value: number, start: number, end: number, origin: number, extent: number) => {
    const near = ROW_GAP - origin - transform.scale * start;
    const far = Math.max(ROW_GAP, extent - ROW_GAP) - origin - transform.scale * end;
    return Math.max(Math.min(near, far), Math.min(Math.max(near, far), value));
  };
  return {
    ...transform,
    x: bound(
      transform.x,
      ((1 - widest) * box.width) / 2,
      ((1 + widest) * box.width) / 2,
      box.left,
      window.innerWidth,
    ),
    y: bound(
      transform.y,
      0,
      (stage.rows.length - 1) * (box.height + stage.gap) + box.height,
      box.top,
      window.innerHeight - footerHeight,
    ),
  };
}

/**
 * The strip's box, where the stage is pinned while it shows: the stage
 * leaves the strip's clip for the window but keeps the strip's size.
 */
function pinOverviewFrame(strip: HTMLElement): void {
  const box = strip.getBoundingClientRect();
  // Set on the stage, which reads them; set higher up, they would not reach it (index.css).
  const stage = strip.querySelector<HTMLElement>(":scope > [data-layout-stage]");
  if (!stage) return;
  stage.style.setProperty("--overview-frame-left", `${box.left}px`);
  stage.style.setProperty("--overview-frame-top", `${box.top}px`);
  stage.style.setProperty("--overview-frame-width", `${box.width}px`);
  stage.style.setProperty("--overview-frame-height", `${box.height}px`);
}

/** Move to `next` once the stage's zoom lands; at once when it does not animate. */
function afterZoom(
  element: HTMLElement,
  durationMs: number,
  next: OverviewPhase,
): (() => void) | undefined {
  if (durationMs === 0) {
    setPhase(next);
    return undefined;
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === "transform") setPhase(next);
  };
  // A transition that never runs (the tab hidden, say) must not strand the stage.
  const fallback = window.setTimeout(() => setPhase(next), durationMs + 100);
  element.addEventListener("transitionend", onEnd);
  return () => {
    window.clearTimeout(fallback);
    element.removeEventListener("transitionend", onEnd);
  };
}

/**
 * The live panes beside the window when the stage sits zoomed in on `row`
 * scrolled to `scroll`: off the strip, but within a window's size of it, so
 * they would linger over the sidebar and the window's edges until the
 * handoff. Panes further out leave the screen early in the zoom.
 */
function panesBesideWindow(
  element: HTMLElement,
  stage: OverviewStageLayout,
  row: OverviewRow,
  scroll: number,
  box: DOMRect,
): HTMLElement[] {
  const camera = zoomedIn(stage, row, scroll, box);
  const near = new Set<string>();
  for (const other of stage.rows) {
    const top = other.index * (box.height + stage.gap) + camera.y;
    const rowLeft = rowLeftShare(other) * box.width + camera.x;
    const stripPx = other.stripWidth * box.width;
    for (const slot of other.slots) {
      const left = rowLeft + slot.rect.left * stripPx;
      const right = left + slot.rect.width * stripPx;
      const paneTop = top + slot.rect.top * box.height;
      const bottom = paneTop + slot.rect.height * box.height;
      const onStrip = right > 1 && left < box.width - 1 && bottom > 1 && paneTop < box.height - 1;
      const nearWindow =
        right > -box.left - window.innerWidth &&
        left < 2 * window.innerWidth - box.left &&
        bottom > -box.top - window.innerHeight &&
        paneTop < 2 * window.innerHeight - box.top;
      if (!onStrip && nearWindow) near.add(slot.paneId);
    }
  }
  return [...element.querySelectorAll<HTMLElement>("[data-layout-pane-id]")].filter((pane) =>
    near.has(pane.dataset.layoutPaneId ?? ""),
  );
}

/**
 * Fades `panes` with the zoom, to the chrome behind the stage and back. A
 * pane caught mid-fade turns from where it is; one held (null) starts from 0.
 * Faded out, a pane holds opacity 0 until the "closed" handoff clears it.
 */
function fadePanes(
  fades: Map<HTMLElement, MotionRun | null>,
  panes: HTMLElement[],
  to: 0 | 1,
): void {
  for (const pane of panes) {
    const run = fades.get(pane);
    const from = run === undefined ? 1 - to : run === null ? 0 : run.value();
    run?.cancel();
    pane.style.opacity = to === 0 ? "0" : "";
    const motion = MotionAnimation.start("overview-open-close", from, to);
    fades.set(
      pane,
      playMotion(pane, motion, (opacity) => ({ opacity })),
    );
  }
}

function applyStageTransform(
  element: HTMLElement,
  transform: StageTransform,
  durationMs: number,
  overlay = element.querySelector<HTMLElement>("[data-layout-overview]"),
): void {
  // Manual input has no transition, so it needs no sampled spring curve.
  const timing = durationMs > 0 ? `${durationMs}ms ${zoomTiming().easing}` : "";
  const transition = durationMs > 0 ? `transform ${timing}` : "none";
  if (element.style.transition !== transition) element.style.transition = transition;
  // Scope inverse zoom to the overlay, not the thousands of nodes in the live panes.
  const scale = String(transform.scale);
  if (overlay && overlay.style.getPropertyValue("--overview-scale") !== scale) {
    overlay.style.setProperty("--overview-scale", scale);
  }
  element.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}

/**
 * Start and finish the zoom at the strip real scroll position.
 * Keep the stage mounted until the closing transform lands, then restore strip scrolling.
 */
export function useOverviewStage(
  phaseNow: OverviewPhase,
  stage: OverviewStageLayout,
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  stageRef: React.RefObject<HTMLDivElement | null>,
): void {
  const staged = useRef(false);
  const exitScroll = useRef(0);
  const manual = useRef<StageTransform | null>(null);
  const zoomShare = useRef(1);
  const selection = useRef("");
  const frameSize = useRef("");
  const fades = useRef(new Map<HTMLElement, MotionRun | null>());
  const interactive = phaseNow === "opening" || phaseNow === "open";
  const readStage = useStableCallback(() => stage);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Bind the overview camera to its mounted DOM and release gesture listeners on exit.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const element = stageRef.current;
    if (!interactive || !scroller || !element) return;
    const overlay = element.querySelector<HTMLElement>("[data-layout-overview]");
    let box = scroller.getBoundingClientRect();
    let footerHeight = closeHintHeight();
    const visible = () => {
      if (manual.current) return manual.current;
      // Read the visible transition once at handoff, never after our camera write.
      box = scroller.getBoundingClientRect();
      footerHeight = closeHintHeight();
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { x: matrix.m41, y: matrix.m42, scale: matrix.a };
    };
    // The camera only moves a landed stage. Taken mid-zoom, the in-between
    // pose would become the overview's resting one, full size at the start.
    const move = (transform: StageTransform) => {
      if (phase !== "open") return;
      const stage = readStage();
      manual.current = boundOverviewTransform(stage, box, transform, footerHeight);
      zoomShare.current = manual.current.scale / stage.scale;
      applyStageTransform(element, manual.current, 0, overlay);
    };
    const camera = {
      pan: (x: number, y: number) => {
        const from = visible();
        move({ ...from, x: from.x + x, y: from.y + y });
      },
      zoom: (factor: number, x: number, y: number) => {
        const from = visible();
        const stage = readStage();
        const maximum = Math.max(1, stage.scale);
        const scale = Math.max(
          stage.scale * MIN_ZOOM_SHARE,
          Math.min(maximum, from.scale * factor),
        );
        const ratio = scale / from.scale;
        const anchorX = x - box.left;
        const anchorY = y - box.top;
        move({
          x: anchorX - (anchorX - from.x) * ratio,
          y: anchorY - (anchorY - from.y) * ratio,
          scale,
        });
        return Math.max(1, (from.scale * factor) / maximum);
      },
    };
    overviewCamera = camera;
    let pinchTravel = 0;
    let pinchReset: number | null = null;
    // A scroll still coasting from the chat, or the pinch that opened the
    // overview, runs on through the zoom; it ends at the first gap.
    let foreignWheelUntil = 0;
    const onWheel = (event: WheelEvent) => {
      if (!isOverviewInteractive() || event.defaultPrevented) return;
      event.preventDefault();
      // Own only the overview: do not also drive the strip's modifier-wheel handler.
      event.stopPropagation();
      if (phase !== "open" || event.timeStamp < foreignWheelUntil) {
        foreignWheelUntil = event.timeStamp + WHEEL_STREAM_GAP_MS;
        return;
      }
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? window.innerHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const overflow = camera.zoom(
          Math.exp(-event.deltaY * unit * WHEEL_ZOOM_RATE),
          event.clientX,
          event.clientY,
        );
        // Chromium pinch has fractional ctrl+wheel deltas; mouse-wheel zoom never closes.
        if (event.ctrlKey && !Number.isInteger(event.deltaY) && event.deltaY < 0) {
          pinchTravel += Math.log(overflow) / WHEEL_ZOOM_RATE;
          if (pinchReset !== null) window.clearTimeout(pinchReset);
          pinchReset = window.setTimeout(() => {
            pinchReset = null;
            pinchTravel = 0;
          }, 200);
          if (pinchTravel > PINCH_THRESHOLD) {
            pinchTravel = 0;
            setOverviewOpen(false);
          }
        } else {
          pinchTravel = 0;
        }
      } else {
        pinchTravel = 0;
        const horizontal = event.shiftKey && event.deltaX === 0;
        const horizontalUnit = event.deltaMode === 2 ? window.innerWidth : unit;
        camera.pan(
          -(horizontal ? event.deltaY : event.deltaX) * horizontalUnit,
          horizontal ? 0 : -event.deltaY * unit,
        );
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    // A genuine resize deliberately returns to the fitted view; rerenders do not.
    const resize = () => {
      const next = `${scroller.clientWidth}x${scroller.clientHeight}x${window.innerWidth}x${window.innerHeight}`;
      if (next === frameSize.current) return;
      const changed = frameSize.current !== "";
      frameSize.current = next;
      box = scroller.getBoundingClientRect();
      footerHeight = closeHintHeight();
      if (!changed) return;
      // The fixed stage must follow a resize even while its entry zoom is running.
      pinOverviewFrame(scroller);
      if (phase !== "open") return;
      manual.current = null;
      zoomShare.current = 1;
      const stage = readStage();
      applyStageTransform(element, zoomedOut(stage, box), 0, overlay);
    };
    resize();
    const stopObserving = observeResize([scroller, document.documentElement], resize);
    return () => {
      stopObserving();
      window.removeEventListener("wheel", onWheel, true);
      if (pinchReset !== null) window.clearTimeout(pinchReset);
      if (overviewCamera === camera) {
        stopOverviewGesture?.();
        overviewCamera = null;
      }
    };
  }, [interactive, scrollerRef, stageRef, readStage]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply overview transforms and cancel in-flight animation frames when geometry changes.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const element = stageRef.current;
    if (!scroller || !element) return;
    const box = scroller.getBoundingClientRect();
    // Navigation motion: the zoom always plays its spring; reduced motion makes it 0.
    const { durationMs } = zoomTiming();
    const nextSelection = `${stage.focusedRow.workspace.id}/${stage.focusedRow.workspace.focusedPaneId}`;
    const selectionChanged = selection.current !== nextSelection;
    selection.current = nextSelection;
    if (phaseNow === "closed") {
      manual.current = null;
      zoomShare.current = 1;
      frameSize.current = "";
      for (const [pane, run] of fades.current) {
        run?.cancel();
        pane.style.opacity = "";
      }
      fades.current.clear();
      if (!staged.current) return;
      staged.current = false;
      element.style.transition = "";
      element.style.transform = "";
      scroller.scrollLeft = exitScroll.current;
      // DOM focus comes back to the pane the overview landed on.
      document
        .querySelector<HTMLElement>(
          "[data-layout-pane-focused='true'][data-layout-pane-id] [contenteditable='true']",
        )
        ?.focus({ preventScroll: true });
      return;
    }
    if (phaseNow === "open") {
      const footerHeight = closeHintHeight();
      if (manual.current && !selectionChanged) {
        manual.current = boundOverviewTransform(stage, box, manual.current, footerHeight);
        zoomShare.current = manual.current.scale / stage.scale;
        applyStageTransform(element, manual.current, 0);
      } else {
        manual.current = null;
        const scale = Math.max(
          stage.scale * MIN_ZOOM_SHARE,
          Math.min(Math.max(1, stage.scale), stage.scale * zoomShare.current),
        );
        applyStageTransform(
          element,
          boundOverviewTransform(stage, box, zoomedOut(stage, box, scale), footerHeight),
          durationMs,
        );
      }
      return;
    }
    if (phaseNow === "opening") {
      if (!staged.current) {
        staged.current = true;
        const start = zoomedIn(stage, stage.focusedRow, entry.scrollLeft, box);
        // A switch caught mid-flight: the focused row still sits that far off.
        start.y -= entry.rowOffset * (box.height + stage.gap);
        applyStageTransform(element, start, 0);
        // Panes beside the window hold at 0 and fade in with the zoom, rather
        // than appearing over the sidebar. Mid-switch two rows share the window.
        if (entry.rowOffset === 0) {
          for (const pane of panesBesideWindow(
            element,
            stage,
            stage.focusedRow,
            entry.scrollLeft,
            box,
          )) {
            pane.style.opacity = "0";
            fades.current.set(pane, null);
          }
        }
      }
      let stopZoom: (() => void) | undefined;
      let frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          // Held panes, and any caught fading out by a reopen, come back.
          fadePanes(fades.current, [...fades.current.keys()], 1);
          if (manual.current) return;
          // Straight to the resting pose "open" keeps, so no pan follows the zoom.
          const footerHeight = closeHintHeight();
          applyStageTransform(
            element,
            boundOverviewTransform(stage, box, zoomedOut(stage, box), footerHeight),
            durationMs,
          );
          stopZoom = afterZoom(element, durationMs, "open");
        });
      });
      return () => {
        window.cancelAnimationFrame(frame);
        stopZoom?.();
      };
    }
    // A host that mounts mid-zoom (the /settings route has its own) has no
    // zoom to finish: it lands at once, and "closed" still hands the scroll back.
    const landMs = staged.current ? durationMs : 0;
    staged.current = true;
    manual.current = null;
    zoomShare.current = 1;
    exitScroll.current = exitScrollLeft(stage.focusedRow, box.width);
    // Panes beside the window fade out on the way, so the sidebar's
    // spot is chrome by the handoff instead of a neighbor that vanishes.
    fadePanes(
      fades.current,
      panesBesideWindow(element, stage, stage.focusedRow, exitScroll.current, box),
      0,
    );
    applyStageTransform(
      element,
      zoomedIn(stage, stage.focusedRow, exitScroll.current, box),
      landMs,
    );
    return afterZoom(element, landMs, "closed");
  }, [phaseNow, scrollerRef, stage, stageRef]);
}

// The layer over the live panes: what a press hits, the focus ring, where
// the window will land, and drop lines while a pane is dragged.

type OverviewDropTarget =
  | { kind: "column"; workspaceId: string; index: number }
  | { kind: "workspace"; index: number };

interface OverviewDrag {
  tabId: string;
  point: { x: number; y: number };
  target: OverviewDropTarget | null;
}

/** A background click closes on release; a drag pans instead. Pane drags keep their handler. */
export function onOverviewBackgroundPointerDown(event: React.PointerEvent): void {
  if (event.button !== 0 || !isOverviewInteractive() || !overviewCamera) return;
  if (event.target instanceof Element && event.target.closest("[data-overview-pane]")) return;
  stopOverviewGesture?.();
  const element = event.currentTarget;
  const pointerId = event.pointerId;
  const camera = overviewCamera;
  const start = { x: event.clientX, y: event.clientY };
  let previous = start;
  let started = false;
  let finished = false;
  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    if (!isOverviewInteractive() || overviewCamera !== camera) return finish(false);
    const point = { x: next.clientX, y: next.clientY };
    if (!started && Math.hypot(point.x - start.x, point.y - start.y) < DRAG_THRESHOLD) return;
    started = true;
    next.preventDefault();
    camera.pan(point.x - previous.x, point.y - previous.y);
    previous = point;
  };
  const finish = (close: boolean) => {
    if (finished) return;
    finished = true;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", blur);
    element.removeEventListener("lostpointercapture", cancel);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    if (stopOverviewGesture === blur) stopOverviewGesture = null;
    if (close && !started && isOverviewInteractive()) setOverviewOpen(false);
  };
  const up = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    move(next);
    finish(true);
  };
  const cancel = (next: Event) => {
    if (next instanceof PointerEvent && next.pointerId === pointerId) finish(false);
  };
  const blur = () => finish(false);
  stopOverviewGesture = blur;
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", blur);
  element.addEventListener("lostpointercapture", cancel);
  element.setPointerCapture(pointerId);
  event.preventDefault();
}

export function OverviewStageOverlay({
  layout,
  stage,
  phase: phaseNow,
}: {
  layout: LayoutState;
  stage: OverviewStageLayout;
  phase: OverviewPhase;
}) {
  const choose = useChooseOverviewTab();
  const { rows, scale, gap } = stage;
  const [drag, setDrag] = useState<OverviewDrag | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const open = phaseNow === "open" || phaseNow === "opening";
  // Unscaled px that show as `px` on screen once zoomed out.
  const px = (value: number) => `calc(${value}px / var(--overview-scale, ${scale}))`;

  const resolveTarget = (
    point: { x: number; y: number },
    tabId: string,
  ): OverviewDropTarget | null => {
    const measured = rows.flatMap((row) => {
      const element = rowRefs.current.get(row.workspace.id);
      return element && row.workspace.columns.length > 0
        ? [{ row, rect: element.getBoundingClientRect() }]
        : [];
    });
    if (measured.length === 0) return null;
    // Inside a row, away from its top and bottom: a new column there.
    for (const { row, rect } of measured) {
      const band = Math.min(20, rect.height / 5);
      if (point.y < rect.top + band || point.y > rect.bottom - band) continue;
      const edges = columnEdges(row);
      const x = (point.x - rect.left) / rect.width;
      let index = 0;
      let best = Number.POSITIVE_INFINITY;
      edges.forEach((edge, edgeIndex) => {
        const distance = Math.abs(edge - x);
        if (distance < best) {
          best = distance;
          index = edgeIndex;
        }
      });
      const target = { kind: "column", workspaceId: row.workspace.id, index } as const;
      return isUsefulColumnDrop(layout, tabId, target) ? target : null;
    }
    // Between rows, above the first or below the last: a new workspace there.
    const stackIndexOf = (workspace: LayoutWorkspace) => layout.workspaces.indexOf(workspace);
    let index = stackIndexOf(measured[0]!.row.workspace);
    for (const { row, rect } of measured) {
      if (point.y > rect.top + rect.height / 2) index = stackIndexOf(row.workspace) + 1;
    }
    return { kind: "workspace", index };
  };

  const beginDrag = (event: React.PointerEvent, tab: LayoutTab) => {
    if (event.button !== 0 || !isOverviewInteractive()) return;
    stopOverviewGesture?.();
    const element = event.currentTarget;
    const tabId = tab.id;
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let started = false;
    let finished = false;
    let latest: OverviewDrag | null = null;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const point = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!started && Math.hypot(point.x - start.x, point.y - start.y) < DRAG_THRESHOLD) return;
      started = true;
      moveEvent.preventDefault();
      const target = resolveTarget(point, tabId);
      // The chip follows the pointer on its own; the overlay re-renders only
      // when the drop target changes.
      const chip = chipRef.current;
      if (chip) chip.style.transform = chipTransform(point);
      const changed = !latest || !sameDropTarget(latest.target, target);
      latest = { tabId, point, target };
      if (changed) setDrag(latest);
    };
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", stop);
      element.removeEventListener("lostpointercapture", cancel);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      releaseOverviewGesture(stop);
      setDrag(null);
      if (!started) {
        // A plain click opens that pane.
        if (commit) choose(tab.id);
        return;
      }
      const target = latest?.target;
      if (!commit || !target) return;
      const store = useLayoutStore.getState();
      if (target.kind === "column") store.moveChatToColumn(tabId, target.workspaceId, target.index);
      else store.moveTabToNewWorkspace(tabId, target.index);
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) finish(true);
    };
    const cancel = (next: Event) => {
      if (next instanceof PointerEvent && next.pointerId === pointerId) finish(false);
    };
    const stop = () => finish(false);
    holdOverviewGesture(stop);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", stop);
    element.addEventListener("lostpointercapture", cancel);
    element.setPointerCapture(pointerId);
    event.stopPropagation();
  };

  const draggedTab = drag
    ? (findLayoutTab(layout, (tab) => tab.id === drag.tabId)?.tab ?? null)
    : null;
  const focusedRowId = stage.focusedRow.workspace.id;
  const workspaceDropIndex = drag?.target?.kind === "workspace" ? drag.target.index : null;
  const workspaceLineRow =
    workspaceDropIndex === null
      ? null
      : (rows.find((row) => layout.workspaces.indexOf(row.workspace) === workspaceDropIndex)
          ?.index ?? rows.length);

  return (
    <div
      data-layout-overview=""
      role="dialog"
      aria-label="Workspaces overview"
      className={cn("absolute inset-0", !open && "pointer-events-none")}
    >
      {rows.map((row) => {
        const focusedRow = row.workspace.id === focusedRowId;
        const tabsById = new Map<string, LayoutTab>();
        for (const column of row.workspace.columns) {
          for (const pane of column.panes) {
            for (const tab of pane.tabs) tabsById.set(tab.id, tab);
          }
        }
        const insertIndex =
          drag?.target?.kind === "column" && drag.target.workspaceId === row.workspace.id
            ? drag.target.index
            : null;
        const edges = columnEdges(row);
        return (
          <div
            key={row.workspace.id}
            ref={(element) => {
              if (element) rowRefs.current.set(row.workspace.id, element);
              else rowRefs.current.delete(row.workspace.id);
            }}
            data-overview-workspace={row.workspace.id}
            className="absolute"
            style={rowBox(row, gap)}
          >
            {row.slots.map((slot) => {
              const tab = slot.activeTabId ? tabsById.get(slot.activeTabId) : undefined;
              if (!tab) return null;
              const focused = open && focusedRow && row.workspace.focusedPaneId === slot.paneId;
              const dragging = drag !== null && tab.id === drag.tabId;
              return (
                <div
                  key={slot.paneId}
                  data-overview-pane={slot.paneId}
                  data-overview-pane-focused={focused ? "true" : undefined}
                  className={cn(
                    "absolute cursor-pointer rounded-pane",
                    dragging && "bg-background/60",
                  )}
                  style={paneBox(slot)}
                  onPointerDown={(event) => beginDrag(event, tab)}
                >
                  {focused ? (
                    <div
                      aria-hidden
                      data-chrome-scope=""
                      className="pointer-events-none absolute rounded-pane border-strong-foreground/70"
                      style={{ inset: px(-3), borderWidth: px(1.5) }}
                    />
                  ) : null}
                </div>
              );
            })}
            {row.workspace.columns.length === 0 && open ? (
              <div
                aria-hidden
                data-chrome-scope=""
                className="pointer-events-none absolute inset-0 rounded-pane border-dashed border-border"
                style={{ borderWidth: px(1) }}
              />
            ) : null}
            {insertIndex !== null ? (
              <div
                aria-hidden
                data-chrome-scope=""
                className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-full bg-strong-foreground"
                style={{
                  left: `${(edges[insertIndex] ?? 1) * 100}%`,
                  top: px(-4),
                  bottom: px(-4),
                  width: px(4),
                }}
              />
            ) : null}
          </div>
        );
      })}
      {workspaceLineRow !== null ? (
        <NewWorkspaceLine
          style={{
            top: `calc(${workspaceLineRow * 100}% + ${workspaceLineRow * gap - gap / 2}px)`,
            transform: `translateY(-50%) scale(calc(1 / var(--overview-scale, ${scale})))`,
          }}
        />
      ) : null}
      {drag && draggedTab ? (
        <OverviewDragChip ref={chipRef} tab={draggedTab} point={drag.point} />
      ) : null}
    </div>
  );
}

/** A pane's box inside its row, 4px from each neighbor (the strip's 8px gap). */
function paneBox(slot: LayoutPaneSlot): React.CSSProperties {
  const side = (has: boolean) => (has ? "4px" : "0px");
  return {
    left: `calc(${slot.rect.left * 100}% + ${side(slot.hasLeft)})`,
    top: `calc(${slot.rect.top * 100}% + ${side(slot.hasAbove)})`,
    width: `calc(${slot.rect.width * 100}% - ${side(slot.hasLeft)} - ${side(slot.hasRight)})`,
    height: `calc(${slot.rect.height * 100}% - ${side(slot.hasAbove)} - ${side(slot.hasBelow)})`,
  };
}

/** Column boundaries of a row as fractions of it, start and end included. */
function columnEdges(row: OverviewRow): number[] {
  const edges = [0];
  for (const column of row.workspace.columns) {
    const slot = row.slots.find((candidate) => candidate.paneId === column.panes[0]?.id);
    edges.push(slot ? slot.rect.left + slot.rect.width : edges.at(-1)!);
  }
  return edges;
}

function isUsefulColumnDrop(
  layout: LayoutState,
  tabId: string,
  target: { workspaceId: string; index: number },
): boolean {
  for (const workspace of layout.workspaces) {
    for (const [columnIndex, column] of workspace.columns.entries()) {
      for (const pane of column.panes) {
        if (!pane.tabs.some((tab) => tab.id === tabId)) continue;
        const alone = column.panes.length === 1 && pane.tabs.length === 1;
        return !(
          alone &&
          workspace.id === target.workspaceId &&
          (target.index === columnIndex || target.index === columnIndex + 1)
        );
      }
    }
  }
  return false;
}

/**
 * The pen's insert line (kLefu) with its "New workspace" pill (K6fnj), drawn
 * at screen size: `style` places it on the stage and undoes the zoom.
 */
function NewWorkspaceLine({ style }: { style: React.CSSProperties }) {
  return (
    <div
      aria-hidden
      data-chrome-scope=""
      className="pointer-events-none absolute inset-x-0 z-10 flex items-center justify-center"
      style={style}
    >
      <div className="h-1 w-[min(700px,80%)] rounded-full bg-strong-foreground" />
      <div className="absolute flex h-6.5 items-center gap-1.5 rounded-control bg-strong-foreground px-2.5 text-meta text-background shadow-lg">
        <PlusIcon aria-hidden className="size-3.25" />
        New workspace
      </div>
    </div>
  );
}

function chipTransform(point: { x: number; y: number }): string {
  return `translate(${point.x - 20}px, ${point.y - 14}px)`;
}

function sameDropTarget(a: OverviewDropTarget | null, b: OverviewDropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "workspace") return b.kind === "workspace" && a.index === b.index;
  return b.kind === "column" && a.workspaceId === b.workspaceId && a.index === b.index;
}

/** What follows the pointer while a pane is dragged: its tab label. */
function OverviewDragChip({
  ref,
  tab,
  point,
}: {
  ref: Ref<HTMLDivElement>;
  tab: LayoutTab;
  point: { x: number; y: number };
}) {
  const label = useLayoutTabLabel(tab);
  return createPortal(
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-50 flex h-7 max-w-60 -rotate-2 items-center gap-1.5 rounded-control bg-popover px-2.5 text-meta text-foreground shadow-2xl [&_svg]:size-3.5"
      style={{ transform: chipTransform(point) }}
    >
      {label.icon}
      <span className="min-w-0 truncate">{label.title}</span>
    </div>,
    document.body,
  );
}
