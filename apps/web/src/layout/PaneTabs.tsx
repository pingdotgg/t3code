import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveTerminalActivityStatus } from "@t3tools/client-runtime/state/terminal";
import {
  type ContextMenuItem,
  type ContextMenuSource,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { contextMenuSourceOf } from "../contextMenuSource";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { msg, useGT, useMessages } from "gt-react";
import { create } from "zustand";
import { useAtomValue } from "@effect/atom-react";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import {
  ChartNoAxesColumnIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GitForkIcon,
  WorkflowIcon,
  PanelRightIcon,
  PlusIcon,
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
  useSyncExternalStore,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { showSideThreadTabAsChat } from "../lib/sideChatPane";
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
import { Button, ContentButton } from "../components/ui/button";
import { cn } from "../lib/utils";
import { requestSideChatComposerFocus } from "../lib/workspaceFocus";
import { sideThreadComposer, sideThreadKindOf } from "@t3tools/client-runtime/side-thread";
import { PANE_GHOST_TAB_TITLE_CLASS, PANE_INACTIVE_TAB_TITLE_CLASS } from "../components/PaneNotch";
import { IssueGlyph } from "../components/issue/issuePresentation";
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
import { m, type MessageResolver } from "../i18n/messages";
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
  canCloseLayoutTab,
} from "./layoutModel";
import {
  closeLayoutTabByUser,
  closeOtherLayoutTabsByUser,
  createLayoutNewTabContent,
  openLayoutNewTab,
  splitLayoutTab,
} from "./layoutActions";
import { beginLayoutContentDrag, beginLayoutTabDrag } from "./layoutDrag";
import { useLayoutPane } from "./layoutPaneContext";
import { isScrollingWorkspacesEnabled } from "./layoutBehavior";
import { useLayoutStore } from "./layoutStore";
import { followLayoutCompanions } from "./openRules";
import {
  scrollLeftByWheel,
  scrollTabStripFromRow,
  setWheelScroller,
  wheelDeltaPx,
} from "../motion/gesture";
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
  /** Clips the joined tab shape outside the strip's alpha mask (index.css, [data-pane-join-layer]). */
  readonly joinLayer: HTMLDivElement;
  readonly join: HTMLSpanElement;
  /** The landed tab's foot, painted beside the strip with the bar (index.css, [data-pane-join-foot]). */
  readonly foot: HTMLElement;
  /** The strip's left in its notch, where the join layer and foot are placed. */
  footOffset: number | null;
  /** Whether the strip starts at its pane's edge, cached on layout changes to avoid scroll reads. */
  atPaneEdge: boolean;
  /** The notch whose bar draws the foot now. */
  footNotch: HTMLElement | null;
  /** Where the joined shape sits or is heading, in the strip's scrolled content. */
  shown: { tabId: string | null; x: number; w: number } | null;
  /** The tab whose label reads as joined: the shape's, once it has landed there. */
  joinedId: string | null;
  /** The slide in flight, if any. */
  slide: Animation | null;
  /** The holding header's panel animation duration, for a slide begun on a press. */
  motionMs: number;
  readonly litProperties: readonly [start: string, end: string];
  lit: { host: HTMLElement; offset: number; width: number } | null;
  width: number;
  scrollLeft: number;
  restoreScroll: boolean;
  overflowing: boolean;
  canStart: boolean;
  canEnd: boolean;
  hoveredTab: HTMLElement | null;
  readonly overflowListeners: Set<() => void>;
  scrollButtons: { start: HTMLButtonElement | null; end: HTMLButtonElement | null };
}

const paneStrips = new Map<string, PaneStrip>();
/** How the header holding a strip places its joined tab, with or without motion. */
const stripPlacers = new WeakMap<HTMLElement, (motionMs: number) => void>();
const stripEntries = new WeakMap<HTMLElement, PaneStrip>();
const pendingPlacements = new Map<HTMLElement, number>();
const pendingReveals = new WeakSet<HTMLElement>();
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
/** The middle's unscaled width (index.css). Scaling a 1px layer at a fractional zoom multiplied its rounding by the tab's width. */
const PANE_JOIN_MIDDLE_PX = 256;
/** The strip's edge fade (index.css), which the revealed tab's ears stay clear of. */
const PANE_STRIP_FADE_PX = 24;
/** The scroll chevron button width (`size="icon-xs"` on desktop, index.css `--strip-chevron-space`). */
const PANE_STRIP_CHEVRON_PX = 24;

let finePointerQuery: MediaQueryList | null = null;
function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  finePointerQuery ??= window.matchMedia("(any-pointer: fine)");
  return finePointerQuery.matches;
}

let reducedMotionQuery: MediaQueryList | null = null;
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  reducedMotionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery.matches;
}

const noop = () => {};

function subscribeStripOverflow(entry: PaneStrip, listener: () => void): () => void {
  entry.overflowListeners.add(listener);
  return () => {
    entry.overflowListeners.delete(listener);
  };
}

/**
 * Target scroll offset for one chevron step: one visible width minus both
 * sides' fades and chevrons, with a floor of half the strip width so narrow
 * panes still advance meaningfully. A step that would leave less than `snap`
 * goes all the way to that end.
 */
function paneStripScrollStepTarget(input: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  padStart: number;
  padEnd: number;
  snap: number;
  side: "start" | "end";
}): number {
  const max = Math.max(0, input.scrollWidth - input.clientWidth);
  if (max <= 0) return 0;
  const visible = input.clientWidth - input.padStart - input.padEnd;
  const distance = Math.max(visible, input.clientWidth / 2);
  if (input.side === "start") {
    const target = Math.max(0, input.scrollLeft - distance);
    return target < input.snap ? 0 : target;
  }
  const target = Math.min(max, input.scrollLeft + distance);
  return max - target < input.snap ? max : target;
}

function scrollStripByStep(entry: PaneStrip, side: "start" | "end"): void {
  const { strip } = entry;
  if (!(side === "start" ? entry.canStart : entry.canEnd)) return;
  const style = getComputedStyle(strip);
  const overhead = PANE_STRIP_FADE_PX + PANE_STRIP_CHEVRON_PX;
  const padStart = (Number.parseFloat(style.paddingInlineStart) || 0) + overhead;
  const padEnd = (Number.parseFloat(style.paddingInlineEnd) || 0) + overhead;
  const target = paneStripScrollStepTarget({
    scrollLeft: strip.scrollLeft,
    scrollWidth: strip.scrollWidth,
    clientWidth: strip.clientWidth,
    padStart,
    padEnd,
    snap: overhead,
    side,
  });
  if (Math.abs(target - strip.scrollLeft) < 0.5) return;
  strip.scrollTo({
    left: target,
    behavior: prefersReducedMotion() ? "instant" : "smooth",
  });
}

function activeStripFocusTarget(strip: HTMLElement): HTMLElement | null {
  return (
    strip.querySelector<HTMLElement>(
      "[data-joined], [data-active-tab='true'], [data-layout-pane-tab]",
    ) ?? null
  );
}

function syncScrollButtonAttrs(button: HTMLButtonElement | null, canScroll: boolean): void {
  if (!button) return;
  const disabled = !canScroll;
  if (button.hasAttribute("data-can-scroll") !== canScroll) {
    button.toggleAttribute("data-can-scroll", canScroll);
  }
  if ((button.getAttribute("aria-disabled") === "true") !== disabled) {
    if (disabled) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  }
}

function syncScrollButtons(entry: PaneStrip): void {
  const { start, end } = entry.scrollButtons;
  // Update both buttons before moving focus so the opposite chevron is already
  // visible if it just became scrollable.
  syncScrollButtonAttrs(start, entry.canStart);
  syncScrollButtonAttrs(end, entry.canEnd);
  if (!entry.canStart && start && document.activeElement === start) {
    (entry.canEnd && end ? end : activeStripFocusTarget(entry.strip))?.focus();
  } else if (!entry.canEnd && end && document.activeElement === end) {
    (entry.canStart && start ? start : activeStripFocusTarget(entry.strip))?.focus();
  }
}

/**
 * Keep a keyboard-focused tab clear of the strip's edge fades and scroll
 * chevrons: browsers only apply `scroll-padding-inline` when the focused
 * element lies outside the scrollport, not when it sits under an overlay
 * inside it.
 */
function scrollFocusedTabIntoClearRange(strip: HTMLElement, target: HTMLElement): void {
  const item =
    target.closest<HTMLElement>(STRIP_TAB_SELECTOR) ??
    target.parentElement?.querySelector<HTMLElement>(STRIP_TAB_SELECTOR) ??
    target;
  const style = getComputedStyle(strip);
  const padStart = Number.parseFloat(style.scrollPaddingInlineStart) || 0;
  const padEnd = Number.parseFloat(style.scrollPaddingInlineEnd) || 0;
  const bounds = strip.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  const clearLeft = bounds.left + padStart;
  const clearRight = bounds.right - padEnd;
  const clearWidth = clearRight - clearLeft;
  let delta = 0;
  if (clearWidth <= 0 || rect.width > clearWidth) {
    delta = rect.left + rect.width / 2 - (clearLeft + clearRight) / 2;
  } else if (rect.left < clearLeft) {
    delta = rect.left - clearLeft;
  } else if (rect.right > clearRight) {
    delta = rect.right - clearRight;
  }
  if (Math.abs(delta) < 1) return;
  const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
  const next = Math.min(max, Math.max(0, strip.scrollLeft + delta));
  if (Math.abs(next - strip.scrollLeft) < 1) return;
  strip.scrollLeft = next;
}

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

function createPaneStrip(role?: "panel"): PaneStrip {
  const strip = document.createElement("div");
  strip.dataset.layoutTabStrip = "";
  strip.className =
    "relative flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
  // The joined tab: two caps (corner, side, ear, rim) and a middle that
  // scales, so it moves by transform alone. Held outside the strip's alpha mask
  // so its fill and rim never dissolve into the chrome at the scrolled edges.
  const joinLayer = document.createElement("div");
  joinLayer.dataset.paneJoinLayer = "";
  joinLayer.setAttribute("aria-hidden", "true");
  const join = document.createElement("span");
  join.dataset.paneJoin = "";
  join.setAttribute("aria-hidden", "true");
  join.hidden = true;
  const body = joinPiece("data-jb");
  body.append(joinCap("l"), joinPiece("data-jm"), joinCap("r"));
  join.append(body);
  joinLayer.append(join);
  const foot = document.createElement("i");
  foot.dataset.paneJoinFoot = "";
  foot.setAttribute("aria-hidden", "true");
  const entry: PaneStrip = {
    strip,
    joinLayer,
    join,
    foot,
    footOffset: null,
    atPaneEdge: false,
    footNotch: null,
    shown: null,
    joinedId: null,
    slide: null,
    motionMs: 0,
    litProperties:
      role === "panel"
        ? ["--pane-lit-panel-start", "--pane-lit-panel-end"]
        : ["--pane-lit-start", "--pane-lit-end"],
    lit: null,
    width: 0,
    scrollLeft: 0,
    restoreScroll: false,
    overflowing: false,
    canStart: false,
    canEnd: false,
    hoveredTab: null,
    overflowListeners: new Set(),
    scrollButtons: { start: null, end: null },
  };
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
      if (!scrollLeftByWheel(strip, event, wheelDeltaPx(event.deltaY, event))) return;
      event.preventDefault();
      event.stopPropagation();
    },
    { passive: false },
  );
  strip.addEventListener(
    "scroll",
    () => {
      if (!entry.restoreScroll) entry.scrollLeft = strip.scrollLeft;
      markStripOverflow(strip);
    },
    { passive: true },
  );
  // The shape leaves on the press, before the switch's render: a click lands
  // on its release, after the incoming chat has been laid out. Track pointer
  // presses so focusin only scrolls for keyboard navigation.
  let pointerPressing = false;
  let pointerPressTimer: number | null = null;
  strip.addEventListener("pointerdown", (event) => {
    pointerPressing = true;
    if (pointerPressTimer !== null) window.clearTimeout(pointerPressTimer);
    pointerPressTimer = window.setTimeout(() => {
      pointerPressing = false;
      pointerPressTimer = null;
    }, 0);
    slideOnPress(entry, event);
  });
  strip.addEventListener("focusin", (event) => {
    if (pointerPressing) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target === strip) return;
    if (!target.matches(":focus-visible")) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    scrollFocusedTabIntoClearRange(strip, target);
  });
  strip.addEventListener("pointerover", (event) =>
    markHoverAtStart(entry, hoveredOutlineTab(strip, event.target)),
  );
  strip.addEventListener("pointerleave", () => markHoverAtStart(entry, null));
  setWheelScroller(strip, () => strip.scrollWidth > strip.clientWidth);
  // A tab opening, closing or changing size moves the others without a render here.
  // Not observeResize: no React state changes, and its flushSync would force the
  // incoming chat's pending render into the tab switch's task.
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- Places a DOM node only; see above.
  const resize = new ResizeObserver((entries) => {
    if (entries.some((resized) => resized.target === strip) && activeTabInView(entry)) {
      pendingReveals.add(strip);
    }
    stripPlacers.get(strip)?.(0);
    markStripOverflow(strip);
  });
  resize.observe(strip, { box: "border-box" });
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

function stripScrollLeft(entry: PaneStrip): number {
  return entry.restoreScroll ? entry.scrollLeft : entry.strip.scrollLeft;
}

/** How much of the strip is scrolled out at each end, for its edge fade. */
function markStripOverflow(strip: HTMLElement): void {
  const row = strip.closest("[data-pane-header]");
  const entry = stripEntries.get(strip);
  const { scrollWidth, clientWidth } = strip;
  const scrollLeft = entry ? stripScrollLeft(entry) : strip.scrollLeft;
  const overflow = scrollWidth > clientWidth;
  if (row && row.hasAttribute("data-tab-row-overflow") !== overflow) {
    row.toggleAttribute("data-tab-row-overflow", overflow);
  }
  const end = scrollWidth - clientWidth - scrollLeft;
  const canStart = scrollLeft > 0.5;
  const canEnd = end > 0.5;
  setPaneLitProperty(strip, "--strip-overflow-start", `${Math.max(0, scrollLeft)}px`);
  setPaneLitProperty(strip, "--strip-overflow-end", `${Math.max(0, end)}px`);
  setPaneLitProperty(strip, "--strip-overflowing-end", canEnd ? "1" : "0");
  setPaneLitProperty(strip, "--strip-overflowing-start", canStart ? "1" : "0");
  if (!entry) return;
  entry.width = clientWidth;
  const overflowChanged = entry.overflowing !== overflow;
  entry.overflowing = overflow;
  entry.canStart = canStart;
  entry.canEnd = canEnd;
  syncScrollButtons(entry);
  if (overflowChanged) {
    for (const listener of entry.overflowListeners) listener();
  }
  markJoinAtStart(entry);
  if (entry.hoveredTab) markHoverAtStart(entry, entry.hoveredTab, true);
  markPaneLit(entry, scrollLeft);
}

function activeTabInView(entry: PaneStrip): boolean {
  const { shown, width } = entry;
  if (shown === null || width === 0) return true;
  const scrollLeft = stripScrollLeft(entry);
  return shown.x + shown.w > scrollLeft && shown.x < scrollLeft + width;
}

/**
 * The joined tab is the first, at the pane's edge (no collapsed sidebar's
 * controls before it): its side runs on down the pane's edge, and the
 * pane's corner there gives way (index.css, data-pane-join-start).
 */
function markJoinAtStart(entry: PaneStrip): void {
  const { strip, shown } = entry;
  const row = strip.closest<HTMLElement>("[data-pane-header]");
  if (!row) return;
  const scrollLeft = stripScrollLeft(entry);
  const atStart =
    shown !== null &&
    !(scrollLeft > 0.5 && hasFinePointer()) &&
    shown.x - scrollLeft <= PANE_JOIN_EAR_PX + 1 &&
    shown.x + shown.w - scrollLeft >= PANE_JOIN_EAR_PX + 14 &&
    stripAtPaneEdge(strip, row);
  // Keep hiding the pane corner while a scrolled joined tab straddles the pane's
  // left edge, but still let its label fade into the tab fill when clipped there.
  const nextValue = !atStart ? null : shown.x - scrollLeft < PANE_JOIN_EAR_PX - 1 ? "clipped" : "";
  const currentValue = row.getAttribute("data-pane-join-start");
  if (currentValue !== nextValue) {
    if (nextValue === null) row.removeAttribute("data-pane-join-start");
    else row.setAttribute("data-pane-join-start", nextValue);
    markPaneJoinedAtStart(row.closest<HTMLElement>("[data-layout-tab-id]"));
  }
}

/**
 * Mirrors "a header in this pane is joined at its start" onto the pane, for
 * its start cut (index.css). A `:has()` there restyled the whole pane on
 * every DOM change inside it, such as each streamed chunk.
 */
function markPaneJoinedAtStart(pane: HTMLElement | null): void {
  if (!pane) return;
  const joined = pane.querySelector("[data-pane-join-start]") !== null;
  if (pane.hasAttribute("data-pane-joined-start") !== joined) {
    pane.toggleAttribute("data-pane-joined-start", joined);
  }
}

/** What a strip's hovered tab last marked. The strip moves between its pane's headers. */
const hoverStartMarks = new WeakMap<HTMLElement, readonly [name: string, element: HTMLElement][]>();

function hoveredOutlineTab(strip: HTMLElement, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const tab =
    target.closest<HTMLElement>(STRIP_TAB_SELECTOR) ??
    target.closest<HTMLElement>(".group\\/tab")?.querySelector<HTMLElement>(STRIP_TAB_SELECTOR) ??
    null;
  return tab && strip.contains(tab) ? tab : null;
}

/**
 * A hovered tab's outline (index.css) runs straight down the pane's edge when
 * the tab sits on it, so the pane's corner under it takes the outline's fill.
 * Attributes, as the joined tab's are: a `:has()` would restyle the whole pane.
 * Uses the geometry cached by measurePaneLit/markStripOverflow so hover reads no layout.
 */
function markHoverAtStart(entry: PaneStrip, tab: HTMLElement | null, force = false): void {
  if (!force && tab === entry.hoveredTab) return;
  entry.hoveredTab = tab;
  const { strip } = entry;
  const next: [name: string, element: HTMLElement][] = [];
  // A scrolled strip fades its start, and the outline with it.
  if (tab && !tab.hasAttribute("data-joined") && !entry.canStart && entry.atPaneEdge) {
    const row = strip.closest<HTMLElement>("[data-pane-header]");
    if (
      row &&
      entry.footOffset !== null &&
      Math.abs(entry.footOffset + PANE_JOIN_EAR_PX) < 1 &&
      strip.closest('[data-pane-notch=""]:not([data-pane-notch-unfocused])') &&
      strip.querySelector<HTMLElement>(STRIP_TAB_SELECTOR) === tab
    ) {
      next.push(["data-pane-hover-start", row]);
      if (entry.lit && Math.abs(entry.lit.offset + PANE_JOIN_EAR_PX) < 1) {
        next.push(["data-pane-hovered-start", entry.lit.host]);
      }
    }
  }
  for (const [name, element] of hoverStartMarks.get(strip) ?? []) {
    if (!next.some((mark) => mark[1] === element)) element.removeAttribute(name);
  }
  for (const [name, element] of next) {
    if (!element.hasAttribute(name)) element.setAttribute(name, "");
  }
  hoverStartMarks.set(strip, next);
}

/** The strip starts at its pane's edge, which clips its ear room (index.css, --pane-join-lead). */
function stripAtPaneEdge(strip: HTMLElement, row: HTMLElement | null): boolean {
  const notch = strip.closest<HTMLElement>('[data-pane-notch=""]');
  if (!notch || !row) return false;
  const style = getComputedStyle(row);
  if (style.getPropertyValue("--pane-titlebar-inset").trim() === "1") return false;
  const lead = notch.getBoundingClientRect().left - row.getBoundingClientRect().left;
  return Math.abs(lead - Number.parseFloat(style.paddingLeft)) < 1;
}

/**
 * How much a transform (the overview) scales an element, 0 when it has no width. offsetWidth is
 * rounded, so within that rounding the element is unscaled: a ratio there would be noise that
 * moves the foot by a hundredth of a pixel, restyling the whole bar, whenever the tab's width changes.
 */
function transformScale(element: HTMLElement, box: DOMRect): number {
  const layoutWidth = element.offsetWidth;
  if (layoutWidth <= 0) return 0;
  return Math.abs(box.width - layoutWidth) <= 0.5 ? 1 : box.width / layoutWidth;
}

function measurePaneLit(entry: PaneStrip): void {
  const notch = entry.strip.closest<HTMLElement>('[data-pane-notch=""]');
  const notchBox = notch?.getBoundingClientRect();
  const notchScale = notch && notchBox ? transformScale(notch, notchBox) : 0;
  entry.footOffset =
    notchBox && notchScale > 0
      ? (entry.strip.getBoundingClientRect().left - notchBox.left) / notchScale
      : null;
  entry.atPaneEdge = stripAtPaneEdge(
    entry.strip,
    entry.strip.closest<HTMLElement>("[data-pane-header]"),
  );
  entry.width = entry.strip.clientWidth;
  const host = entry.strip.closest<HTMLElement>("[data-layout-pane-id]");
  if (entry.lit && entry.lit.host !== host) {
    clearPaneLit(entry);
    entry.lit = null;
  }
  if (!host) return;
  const hostBox = host.getBoundingClientRect();
  const scale = transformScale(host, hostBox);
  if (scale <= 0) return;
  entry.lit = {
    host,
    offset: (entry.strip.getBoundingClientRect().left - hostBox.left) / scale,
    width: entry.strip.clientWidth,
  };
}

/**
 * The landed tab's foot is drawn with the bar (index.css, data-pane-join-footed)
 * while the whole tab is clear of the strip's clipped edges. A sliding or clipped
 * tab draws its own foot.
 */
function markJoinFoot(
  entry: PaneStrip,
  scrollLeft: number,
  lead: number,
  visibleEnd: number,
): void {
  const { shown, strip, footOffset } = entry;
  const notch = strip.closest<HTMLElement>('[data-pane-notch=""]');
  const left = shown ? shown.x - scrollLeft - PANE_JOIN_EAR_PX : 0;
  const right = shown ? left + shown.w + 2 * PANE_JOIN_EAR_PX : 0;
  const footed =
    notch !== null &&
    shown !== null &&
    footOffset !== null &&
    entry.slide === null &&
    !entry.join.hidden &&
    left >= lead &&
    right <= visibleEnd;
  if (entry.footNotch && entry.footNotch !== (footed ? notch : null)) {
    entry.footNotch.removeAttribute("data-pane-join-footed");
  }
  entry.footNotch = footed ? notch : null;
  if (!footed) return;
  // Not inherited (index.css): the notch's cut and the foot each take their own.
  for (const element of [notch, entry.foot]) {
    setPaneLitProperty(element, "--pane-join-foot-x", `${footOffset + left}px`);
    setPaneLitProperty(element, "--pane-join-foot-w", `${right - left}px`);
  }
  if (!notch.hasAttribute("data-pane-join-footed")) notch.setAttribute("data-pane-join-footed", "");
}

function markPaneLit(entry: PaneStrip, scrollLeft: number): void {
  const { strip, lit, shown, footOffset } = entry;
  const overflowEnd = strip.scrollWidth - strip.clientWidth - scrollLeft;
  const canStart = scrollLeft > 0.5;
  const canEnd = overflowEnd > 0.5;
  const lead = canStart && entry.atPaneEdge ? PANE_JOIN_EAR_PX : 0;
  const visibleEnd = entry.width - (canEnd ? PANE_JOIN_TAIL_PX : 0);
  if (footOffset !== null) {
    setPaneLitProperty(entry.joinLayer, "--pane-join-layer-x", `${footOffset + lead}px`);
    setPaneLitProperty(
      entry.joinLayer,
      "--pane-join-layer-w",
      `${Math.max(0, visibleEnd - lead)}px`,
    );
  }
  setPaneLitProperty(entry.joinLayer, "--pane-join-layer-lead", `${lead}px`);
  setPaneLitProperty(entry.joinLayer, "--pane-join-layer-tail", `${entry.width - visibleEnd}px`);
  const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
  setPaneLitProperty(entry.join, "--pane-join-max-scroll", `${maxScroll}px`);
  setPaneLitProperty(entry.join, "--pane-join-lead-x", `${lead}px`);
  setPaneLitProperty(entry.join, "--pane-join-scroll", `${scrollLeft + lead}px`);
  const fine = hasFinePointer();
  const chevronFade = fine ? PANE_STRIP_CHEVRON_PX + PANE_STRIP_FADE_PX : 0;
  const footLead = canStart && chevronFade > 0 ? PANE_JOIN_EAR_PX + chevronFade : lead;
  const footEnd = canEnd && chevronFade > 0 ? visibleEnd - chevronFade : visibleEnd;
  markJoinFoot(entry, scrollLeft, footLead, footEnd);
  if (!lit) return;
  const litLead = canStart && fine ? PANE_JOIN_EAR_PX + PANE_STRIP_CHEVRON_PX : lead;
  const litEnd = canEnd && fine ? visibleEnd - PANE_STRIP_CHEVRON_PX : visibleEnd;
  const start = shown ? Math.max(litLead, shown.x - scrollLeft - PANE_JOIN_EAR_PX) : 0;
  const end = shown ? Math.min(litEnd, shown.x + shown.w - scrollLeft + PANE_JOIN_EAR_PX) : 0;
  if (entry.join.hidden || end <= start) {
    clearPaneLit(entry);
    return;
  }
  const [startProperty, endProperty] = entry.litProperties;
  for (const cut of litCuts(lit.host)) {
    setPaneLitProperty(cut, startProperty, `${Math.round(lit.offset + start)}px`);
    setPaneLitProperty(cut, endProperty, `${Math.round(lit.offset + end)}px`);
  }
}

/**
 * The cuts that leave room for the lit rim (index.css) take its span on
 * themselves: inheriting it from the pane would restyle every child of the
 * pane whenever the pane moves.
 */
function litCuts(host: HTMLElement): NodeListOf<HTMLElement> {
  return host.querySelectorAll<HTMLElement>(':scope > [data-pane-cut$="notch"]');
}

/** A pane's cuts, mounted again (SurfaceHost.tsx PaneCuts), take its lit span. */
export function markPaneCutsLit(host: HTMLElement): void {
  for (const entry of paneStrips.values()) {
    if (entry.lit?.host === host) markPaneLit(entry, stripScrollLeft(entry));
  }
}

function setPaneLitProperty(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
}

function clearPaneLit(entry: PaneStrip): void {
  if (!entry.lit) return;
  for (const cut of litCuts(entry.lit.host)) {
    for (const property of entry.litProperties) cut.style.removeProperty(property);
  }
}

function paneStripFor(key: string, role?: "panel"): PaneStrip {
  let entry = paneStrips.get(key);
  if (!entry) {
    entry = createPaneStrip(role);
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
  pendingReveals.add(entry.strip);
  schedulePlacement(entry.strip, motionMs);
}

function attachPaneStrip(entry: PaneStrip, slot: HTMLElement, host: HTMLElement): void {
  if (entry.joinLayer.parentNode !== slot) moveInto(slot, entry.joinLayer);
  if (entry.strip.parentNode !== host) {
    // Inserted again, the strip starts unscrolled; the next placement puts its scroll back.
    entry.restoreScroll = true;
    moveInto(host, entry.strip);
  }
  if (entry.foot.parentNode !== slot) moveInto(slot, entry.foot);
}

function restorePaneStripScroll(entry: PaneStrip): void {
  if (!entry.restoreScroll) return;
  entry.restoreScroll = false;
  entry.strip.scrollLeft = entry.scrollLeft;
  markStripOverflow(entry.strip);
}

/** Forget a pane's strip once no header holds it, after the commit that may hand it on. */
function releasePaneStrip(key: string, entry: PaneStrip): void {
  queueMicrotask(() => {
    if (entry.strip.isConnected || paneStrips.get(key) !== entry) return;
    clearPaneLit(entry);
    setWheelScroller(entry.strip, null);
    paneStrips.delete(key);
  });
}

/** Before its header places it; constant, so a render never writes the layer's display back. */
const HIDDEN_STRIP_LAYER = { display: "none" } as const;

/** A header's tabs: in the pane's strip while its header shows, hidden in its own row otherwise. */
function showStripLayer(layer: HTMLElement, parent: HTMLElement, shown: boolean): void {
  layer.style.display = shown ? "contents" : "none";
  if (layer.parentNode !== parent) moveInto(parent, layer);
}

function moveInto(parent: HTMLElement, node: HTMLElement): void {
  // Not moveBefore: Chrome stops restyling a node it moves into a pane that the same commit
  // shows out of content-visibility:hidden (SurfaceHost.tsx), leaving the strip blank or stale.
  parent.append(node);
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
  if (entry.hoveredTab) markHoverAtStart(entry, entry.hoveredTab, true);
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
  measurePaneLit(entry);
  entry.shown = to;
  join.hidden = false;
  const middle = (width: number) =>
    Math.max(0, width - 2 * PANE_JOIN_RADIUS_PX) / PANE_JOIN_MIDDLE_PX;
  join.style.setProperty("--jx", `${to.x}px`);
  join.style.setProperty("--jw", `${to.w}px`);
  join.style.setProperty("--jm", String(middle(to.w)));
  markJoinAtStart(entry);
  markPaneLit(entry, entry.strip.scrollLeft);
  const land = () => {
    entry.slide = null;
    entry.joinedId = to.tabId;
    markJoinedLabel(entry);
    markStripOverflow(entry.strip);
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
  for (const animation of join.firstElementChild?.getAnimations({ subtree: true }) ?? []) {
    animation.cancel();
  }
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
      { translate: `${from.x + r}px 0`, scale: `${middle(from.w)} 1` },
      { translate: `${to.x + r}px 0`, scale: `${middle(to.w)} 1` },
    ],
    timing,
  );
  if (!slide) {
    land();
    return;
  }
  entry.slide = slide;
  markPaneLit(entry, entry.strip.scrollLeft);
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
    markJoinAtStart(entry);
    clearPaneLit(entry);
    markPaneLit(entry, strip.scrollLeft);
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

function scrollStripFromGap(event: WheelEvent, strip: HTMLElement): void {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  if (event.target instanceof Node && strip.contains(event.target)) return;
  if (event.target instanceof Element && event.target.closest("button, [role='button'], a, input"))
    return;
  if (strip.scrollWidth <= strip.clientWidth) return;
  const box = strip.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX >= box.right) return;
  if (event.clientY < box.top || event.clientY >= box.bottom) return;
  if (!scrollLeftByWheel(strip, event, wheelDeltaPx(event.deltaY, event))) return;
  event.preventDefault();
  event.stopPropagation();
}

/** Reveal the active tab in a strip wider than its pane, keeping the joined tab's ears inside. */
function revealPaneTab(strip: HTMLElement, tabId: string | null): number | null {
  const tab = findStripTab(strip, tabId);
  if (!tab) return null;
  const bounds = strip.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  // Room for the joined tab's ears inside the strip's clip, and at the end for
  // its rim's tail, which the next control on the bar overlaps. At the pane's
  // edge the pane clips the strip's ear room and the fade starts past it.
  const clipped = stripAtPaneEdge(strip, strip.closest("[data-pane-header]"))
    ? PANE_JOIN_EAR_PX
    : 0;
  const chevron = hasFinePointer() ? PANE_STRIP_CHEVRON_PX : 0;
  const start = bounds.left + clipped + PANE_JOIN_EAR_PX + PANE_STRIP_FADE_PX + chevron;
  const end = bounds.right - PANE_JOIN_EAR_PX - PANE_JOIN_TAIL_PX - PANE_STRIP_FADE_PX - chevron;
  // A file tab's trailing breadcrumb names the file; reveal it before its thread label.
  if (rect.width > end - start && tab.dataset.layoutTabReveal === "end") return rect.right - end;
  if (rect.left < start) return rect.left - start;
  if (rect.right > end) return rect.right - end;
  return 0;
}

function scrollWithSlide(entry: PaneStrip, left: number): void {
  const { strip, slide } = entry;
  const from = strip.scrollLeft;
  const to = Math.min(Math.max(0, left), strip.scrollWidth - strip.clientWidth);
  if (Math.abs(to - from) < 0.5) return;
  const start = slide?.effect?.getComputedTiming().progress;
  if (!slide || start == null || start >= 1) {
    strip.scrollLeft = to;
    return;
  }
  let written = from;
  const follow = () => {
    if (Math.abs(strip.scrollLeft - written) > 1) return;
    const progress =
      slide.playState === "finished" ? 1 : slide.effect?.getComputedTiming().progress;
    if (progress == null) return;
    written = from + ((to - from) * (progress - start)) / (1 - start);
    strip.scrollLeft = written;
    if (progress < 1) requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
}

function attachScrollButton(
  entry: PaneStrip,
  side: "start" | "end",
  node: HTMLButtonElement | null,
): () => void {
  entry.scrollButtons[side] = node;
  if (node) syncScrollButtons(entry);
  return () => {
    if (entry.scrollButtons[side] === node) {
      entry.scrollButtons[side] = null;
    }
  };
}

function PaneStripScrollButton({ entry, side }: { entry: PaneStrip; side: "start" | "end" }) {
  const gt = useGT();
  return (
    <Button
      ref={(node) => attachScrollButton(entry, side, node)}
      variant="ghost"
      size="icon-xs"
      aria-label={side === "start" ? gt("Previous tabs") : gt("Next tabs")}
      data-strip-scroll-button={side}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => scrollStripByStep(entry, side)}
      className={cn(
        "absolute top-1/2 z-10 -translate-y-1/2 [-webkit-app-region:no-drag]",
        side === "start" ? "start-0" : "end-0",
      )}
    >
      {side === "start" ? (
        <ChevronLeftIcon aria-hidden className="rtl:-scale-x-100" />
      ) : (
        <ChevronRightIcon aria-hidden className="rtl:-scale-x-100" />
      )}
    </Button>
  );
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
  const entry = own ?? paneStripFor(key!, role);
  const holds = own !== null || visible;
  const motionMs = usePaneJoinMotionMs();
  const slotRef = useRef<HTMLSpanElement>(null);
  const stripHostRef = useRef<HTMLSpanElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const overflowing = useSyncExternalStore(
    (listener) => (holds ? subscribeStripOverflow(entry, listener) : noop),
    () => (holds ? entry.overflowing : false),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hold the pane's persistent strip node in this header's row.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const stripHost = stripHostRef.current;
    const layer = layerRef.current;
    if (!slot || !stripHost || !layer) return;
    const { strip } = entry;
    if (!holds) {
      showStripLayer(layer, stripHost, false);
      return;
    }
    attachPaneStrip(entry, slot, stripHost);
    showStripLayer(layer, strip, true);
    const row = strip.closest<HTMLElement>("[data-pane-header]");
    const pane = row?.closest<HTMLElement>("[data-layout-tab-id]") ?? null;
    const wheel = (event: WheelEvent) => {
      scrollStripFromGap(event, strip);
      scrollTabStripFromRow(event, strip);
    };
    row?.addEventListener("wheel", wheel, { passive: false });
    markStripOverflow(strip);
    // The collapsed sidebar's inset moves the strip off the pane's edge
    // without resizing it; the row's content box tracks that inset.
    // oxlint-disable-next-line t3code/no-raw-resize-observer -- Marks DOM attributes and styles only, as the strip's own observer does.
    const inset = new ResizeObserver(() => {
      measurePaneLit(entry);
      markJoinAtStart(entry);
      if (entry.hoveredTab) markHoverAtStart(entry, entry.hoveredTab, true);
      markPaneLit(entry, stripScrollLeft(entry));
    });
    if (row) inset.observe(row);
    const notch = strip.closest('[data-pane-notch=""]');
    if (notch) inset.observe(notch, { box: "border-box" });
    return () => {
      inset.disconnect();
      row?.removeEventListener("wheel", wheel);
      row?.removeAttribute("data-tab-row-overflow");
      if (entry.hoveredTab) markHoverAtStart(entry, null);
      if (row?.hasAttribute("data-pane-join-start")) {
        row.removeAttribute("data-pane-join-start");
        markPaneJoinedAtStart(pane);
      }
    };
  }, [entry, holds]);
  // A tab press changes only which tab the strip's joined shape goes to, placed in the next frame.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Place the pane strip's joined tab after each commit.
  useLayoutEffect(() => {
    if (!holds) return;
    const { strip } = entry;
    const place = (motion: number) => {
      restorePaneStripScroll(entry);
      const reveal = pendingReveals.has(strip) ? revealPaneTab(strip, tabId) : null;
      if (reveal !== null) pendingReveals.delete(strip);
      placePaneJoin(entry, tabId, motion);
      if (reveal) scrollWithSlide(entry, strip.scrollLeft + reveal);
    };
    holdPaneStrip(entry, place, motionMs);
  }, [entry, holds, motionMs, tabId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Take this header's tabs out of the pane's strip, and drop the strip once its last header lets go of it.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    return () => {
      layer?.remove();
      if (key !== null) releasePaneStrip(key, entry);
    };
  }, [entry, key]);
  // This header's tabs, mounted while the header is hidden; only the shown header's layer sits in
  // the pane's strip. Moved, not portaled: a portal target takes React's whole delegated listener
  // set. The slot is the layer's only React parent and leaves with it.
  return (
    <span ref={slotRef} data-layout-tab-strip-slot="" className="contents">
      <div data-layout-tab-strip-frame="" className="relative flex min-w-0 items-center">
        {holds && overflowing ? <PaneStripScrollButton entry={entry} side="start" /> : null}
        <span ref={stripHostRef} className="contents">
          <div ref={layerRef} data-strip-layer="" style={HIDDEN_STRIP_LAYER}>
            {children}
          </div>
        </span>
        {holds && overflowing ? <PaneStripScrollButton entry={entry} side="end" /> : null}
      </div>
    </span>
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

/** Layout actions for a tab's context menu (pen lLm7Y 3). */
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
      ? [{ id: "layout:keep", label: m(msg("Keep open")), icon: "pin" } as const]
      : []),
    {
      id: "layout:split-right",
      label: m(msg("Split right")),
      icon: "panel-right",
      ...keys("layout.splitRight"),
    },
    {
      id: "layout:split-down",
      label: m(msg("Split down")),
      icon: "panel-bottom",
      ...keys("layout.splitDown"),
    },
  ];
  if (hasSiblings || paneCount > 1) {
    items.push({
      id: "layout:new-column",
      label: m(msg("Move to a new column")),
      icon: "columns-2",
    });
  }
  if (isScrollingWorkspacesEnabled() && countLayoutTabs(layout) > 1) {
    items.push({
      id: "layout:new-workspace",
      label: m(msg("Move to a new workspace")),
      icon: "layers-2",
    });
  }
  if (paneCount > 1) {
    const filled = useLayoutStore.getState().maximizedTabId === tabId;
    items.push({
      id: "layout:fill",
      label: filled ? m(msg("Show every pane")) : m(msg("Fill the window")),
      icon: "maximize",
      ...keys("layout.fill"),
    });
  }
  if (location.tab.content.kind === "chat" && location.tab.content.target.kind === "server") {
    items.push({
      id: "layout:copy-link",
      label: m(msg("Copy link")),
      icon: "link",
      separatorBefore: true,
    });
  }
  if (canCloseLayoutTab(layout, tabId)) {
    items.push({
      id: "layout:close-tab",
      label: m(msg("Close")),
      icon: "x",
      ...keys("tab.close"),
      separatorBefore: !items.some((item) => item.id === "layout:copy-link"),
    });
  }
  if (hasSiblings) {
    items.push({ id: "layout:close-other-tabs", label: m(msg("Close others")), icon: "copy-x" });
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
      void writeTextToClipboard(link, {
        target: "thread link",
        unavailableMessage: msg("Clipboard API is unavailable while copying link."),
        failureMessage: msg("Failed to copy link to the clipboard."),
      }).catch(() => toastManager.add({ type: "error", title: m(msg("Could not copy the link")) }));
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

type SurfaceTabMenuId = "open-in-main-view" | "rename" | "copy-path" | "toggle-mute";

/**
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
export function tabMuteMenuItem(
  input: {
    overlay: DesktopPreviewOverlay | null;
    canResolveRuntimeTabId: boolean;
  },
  resolve: MessageResolver = m,
): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? resolve(msg("Unmute tab")) : resolve(msg("Mute tab")),
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
  if (surface?.kind === "thread") {
    items.push({ id: "open-in-main-view", label: m(msg("Open in main view")) });
  }
  if (surface?.kind === "device") items.push({ id: "rename", label: m(msg("Rename")) });
  if (surface?.kind === "file" && surface.attachment === undefined) {
    items.push({ id: "copy-path", label: m(msg("Copy path")) });
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
      if (action === "open-in-main-view" && surface?.kind === "thread") {
        showSideThreadTabAsChat(scopeThreadRef(threadRef.environmentId, surface.threadId));
      } else if (action === "copy-path" && surface?.kind === "file" && !surface.attachment) {
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
  source?: ContextMenuSource,
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
    source,
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
  const gt = useGT();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "tab.close");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContentButton
            variant="tab-close"
            type="button"
            aria-label={gt("Close {title}", { title })}
            className="absolute start-2.25 top-1/2 -translate-y-1/2"
            data-tab-close=""
            onClick={() => closeLayoutTabByUser(tabId)}
          />
        }
      >
        <XIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {shortcut ? gt("Close tab ({shortcut})", { shortcut }) : gt("Close tab")}
      </TooltipPopup>
    </Tooltip>
  );
}

export function LayoutNewTabButton({ tabId }: { tabId: string | null }) {
  const gt = useGT();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "tab.new");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="bare"
            size="icon-xs"
            data-pane-notch-add=""
            data-layout-new-tab=""
            aria-label={gt("New tab")}
            onPointerDown={(event) =>
              beginLayoutContentDrag(event, {
                kind: "new-tab",
                content: createLayoutNewTabContent(tabId),
              })
            }
            onClick={() => {
              if (tabId !== null) useLayoutStore.getState().focusTab(tabId);
              openLayoutNewTab();
            }}
          />
        }
      >
        <PlusIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {shortcut ? gt("New tab ({shortcut})", { shortcut }) : gt("New tab")}
      </TooltipPopup>
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
      onOpenMenu={(position, source) =>
        void showLayoutTabMenu(tab.id, position, keybindings, undefined, source)
      }
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
  onOpenMenu: (position: { x: number; y: number }, source?: ContextMenuSource) => void;
}) {
  const label = useLayoutTabLabel(tab);
  const focusTab = () => {
    followLayoutCompanions(() => useLayoutStore.getState().focusTab(tab.id));
    // Choosing a side chat's tab puts the keyboard in its message box.
    const { content } = tab;
    if (content.kind === "surface" && content.surfaceId.startsWith("thread:")) {
      // A thread with no composer, or one not known yet, takes focus as any other tab does.
      const kind = sideThreadKindOf(
        readThreadShell(
          scopeThreadRef(
            content.threadRef.environmentId,
            ThreadId.make(content.surfaceId.slice("thread:".length)),
          ),
        ),
      );
      if (kind !== null && sideThreadComposer(kind) === "composer") {
        requestSideChatComposerFocus(content.threadRef, content.surfaceId);
      }
    }
  };
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenMenu({ x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
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
  const gt = useGT();
  const messages = useMessages();
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
    surface?.kind === "thread" && surfaceThreadRef
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
        ? gt("Settings")
        : tab.content.kind === "usage"
          ? gt("Usage")
          : tab.content.kind === "issues"
            ? gt("Issues", { $context: "sidebar link to the list of issues" })
            : tab.content.kind === "workflows"
              ? gt("Workflows")
              : gt("Pull requests");
    const Icon =
      tab.content.kind === "settings"
        ? SettingsIcon
        : tab.content.kind === "usage"
          ? ChartNoAxesColumnIcon
          : tab.content.kind === "issues"
            ? IssueGlyph.issue
            : tab.content.kind === "workflows"
              ? WorkflowIcon
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
      title: gt("New tab"),
      tooltip: gt("New tab"),
    };
  }
  if (tab.content.kind === "surface") {
    // The resource owns the title. Its thread, location and state belong in the tooltip.
    const threadTerminal = tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID;
    const threadTitle =
      thread?.title ??
      (surfaceDraft ? gt("New thread") : null) ??
      (threadless
        ? (project?.title ??
          (isThreadlessHomeRef(surfaceThreadRef) &&
          surface?.kind !== "preview" &&
          surface?.kind !== "device"
            ? "~"
            : null))
        : null);
    const title = surface
      ? (sideChat?.title ??
        surfaceTabTitle(surface, preview, terminal?.state.summary?.label, messages))
      : terminalRef
        ? terminalTabTitle(activeTerminalId, terminal?.state.summary?.label, messages)
        : gt("Surface", { $context: "a side panel tab with no known kind" });
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
          : surface?.kind === "pull-request" || surface?.kind === "issue"
            ? (surface.url ?? null)
            : null;
    const status =
      terminalRef || surface?.kind === "terminal"
        ? terminalRunning
          ? gt("Process running")
          : terminal && resolveTerminalActivityStatus(terminal.state) === "failed"
            ? gt("Last command failed")
            : gt("Idle", { $context: "terminal status" })
        : null;
    const browserLabel = gt("Browser");
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
        surface?.kind === "preview" && title !== browserLabel ? browserLabel : null,
        threadTitle,
        path,
        url,
        status,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  const title = thread?.title ?? gt("New thread");
  if (tab.ghostOf) {
    return {
      icon: <GitForkIcon aria-hidden className="size-3.5 shrink-0" />,
      title,
      tooltip: ghostTabTooltip(title, ghostParent?.title, messages),
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
    tooltip: isLayoutGhostTab(tab) ? ghostTabTooltip(tooltip, undefined, messages) : tooltip,
  };
}

/** A ghost tab names the thread it was opened from, if any, and how to keep it. */
export function ghostTabTooltip(
  title: string,
  parentTitle: string | undefined,
  resolve: MessageResolver = m,
): string {
  return [
    title,
    parentTitle ? resolve(msg("Opened from {title}", { title: parentTitle })) : null,
    resolve(msg("Double-click to keep open")),
  ]
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
