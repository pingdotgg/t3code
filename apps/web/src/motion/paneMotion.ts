/** Translate on whole device pixels without scaling or fades. Change sizes once so live timelines
 * never lay out per frame. */
import { Component, useEffectEvent, useLayoutEffect, useRef } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { MotionAnimation, playMotion, toDevicePixel, type MotionRun } from "./animation";
import { takePaneDrop } from "./paneDrop";
import { configureMotion } from "./registry";
import { afterResizeObservers, liftSlideClips, sidebarSlideStarting } from "./slideTrack";
import { stripCameraPosition } from "./stripCamera";

/** What rides a resized pane's edge or lane: the sidebar slide's tracked elements, and the header's
 * top-right cluster (window-fixed in a lone pane, pane-anchored once split). */
const TRACKED = "[data-sidebar-slide-track], [data-workspace-titlebar-controls]";

type Anchor = "start" | "end";

/** `end` stays with the pane's right edge. A lane (`center`, or a `lane` box that carries one)
 * keeps the pane's left edge, or its right one when only that stays put on screen, so it starts
 * inside the pane and its scroller, or under the neighbour its pane grows beneath. */
function trackedEdge(element: HTMLElement, rect: { left: number; right: number }, anchor: Anchor) {
  const track = element.dataset.paneSlideTrack ?? element.dataset.sidebarSlideTrack ?? "end";
  if (track === "end") return rect.right;
  if (track !== "center" && track !== "lane") return rect.left;
  return anchor === "end" ? rect.right : rect.left;
}

/** A `lane` box moves with the lane inside it. */
function trackedRect(element: HTMLElement) {
  const lane =
    element.dataset.paneSlideTrack === "lane"
      ? element.querySelector<HTMLElement>('[data-sidebar-slide-track="center"]')
      : null;
  const { left, right } = (lane ?? element).getBoundingClientRect();
  return { left, right };
}

interface Shown {
  /** The strip's left edge then, which a sidebar slide moves. */
  strip: number;
  elements: Map<HTMLElement, { left: number; right: number }>;
  /** Taken before the sidebar's commit, which moves the panes before React lays them out. */
  held: boolean;
  /** Inline details cards, in stage px. */
  cards: { card: HTMLElement; left: number; top: number; width: number }[];
}

/** The strip's left edge on screen, which the camera's transform on the stage leaves alone. */
const stripLeft = (stage: HTMLElement) =>
  (stage.parentElement ?? stage).getBoundingClientRect().left;

/** Where each tracked element showed before the commit that moved the panes. */
const shownBefore = new WeakMap<HTMLElement, Shown>();

function snapshot(stage: HTMLElement, held: boolean) {
  const elements = new Map<HTMLElement, { left: number; right: number }>();
  for (const element of stage.querySelectorAll<HTMLElement>(TRACKED)) {
    if (!element.closest("[data-layout-closing]")) elements.set(element, trackedRect(element));
  }
  const origin = stage.getBoundingClientRect();
  const cards = [
    ...stage.querySelectorAll<HTMLElement>('[data-thread-details-panel="inline"]'),
  ].map((card) => {
    const { left, top, width } = card.getBoundingClientRect();
    return { card, left: left - origin.left, top: top - origin.top, width };
  });
  shownBefore.set(stage, { strip: stripLeft(stage), elements, held, cards });
}

/** A pane sliding in over the room its donor gave up; `release` runs once it rests. */
interface Opening {
  box: PaneBox;
  release: (() => void) | undefined;
}

/** A details card its narrowed pane moves into a popover stays where it showed, under the pane
 * sliding in over it, until that pane rests; React has already unmounted it. */
function holdCoveredCards(cards: Shown["cards"], box: Box, edge: HTMLElement) {
  const covered = cards.filter(
    ({ card, left, width }) =>
      !card.isConnected && left >= box.x - 1 && left + width <= box.x + box.width + 1,
  );
  for (const { card, left, top, width } of covered) {
    card.inert = true;
    card.setAttribute("aria-hidden", "true");
    Object.assign(card.style, {
      left: `${left}px`,
      top: `${top}px`,
      right: "auto",
      width: `${width}px`,
      transition: "none",
      // Over the donor's fill, under the edge and the pane that covers it.
      zIndex: "-1",
    });
    edge.before(card);
  }
  return () => {
    for (const { card } of covered) card.remove();
  };
}

/** Before a sidebar toggle commits: what its split panes show now. */
export function holdPaneContent(): void {
  for (const stage of document.querySelectorAll<HTMLElement>("[data-layout-stage]")) {
    snapshot(stage, true);
  }
}

/** Once the sidebar slide starts, a held snapshot no pane motion took is stale. */
export function releasePaneContent(): void {
  for (const stage of document.querySelectorAll<HTMLElement>("[data-layout-stage]")) {
    if (shownBefore.get(stage)?.held) shownBefore.delete(stage);
  }
}

/** A closing pane's elements and their children before the commit that unmounts it, whose portals
 * (its tabs and breadcrumb in the bar) React empties as it goes. */
const closingChildren = new WeakMap<HTMLElement, [Element, Node[]][]>();

type Slots = ReadonlyMap<string, { slot: { paneId: string } }>;

/** Measures the tracked elements before React writes a new pane layout to the DOM. */
export class PaneMotionSnapshot extends Component<{
  stageRef: React.RefObject<HTMLElement | null>;
  slots: Slots;
}> {
  override getSnapshotBeforeUpdate(previous: Readonly<{ slots: Slots }>) {
    const stage = this.props.stageRef.current;
    if (!stage || previous.slots === this.props.slots) return null;
    if (!shownBefore.get(stage)?.held) snapshot(stage, false);
    const panes = new Set([...this.props.slots.values()].map(({ slot }) => slot.paneId));
    for (const [tabId, { slot }] of previous.slots) {
      if (this.props.slots.has(tabId) || panes.has(slot.paneId)) continue;
      const pane = stage.querySelector<HTMLElement>(
        `:scope > [data-layout-surface][data-layout-tab-id="${CSS.escape(tabId)}"]`,
      );
      if (!pane) continue;
      closingChildren.set(
        pane,
        [pane, ...pane.querySelectorAll("*")].map((element) => [element, [...element.childNodes]]),
      );
    }
    return null;
  }

  override componentDidUpdate() {}

  override render() {
    return null;
  }
}

const tracks = new WeakMap<HTMLElement, MotionRun>();
const unlifts = new Map<HTMLElement, () => void>();

/** Sends each tracked element straight from where it showed to where it lands, in step with the
 * panes; a pane whose content starts past its box stops clipping it until they rest. */
function trackContent(
  stage: HTMLElement,
  shown: Map<HTMLElement, { left: number; right: number }>,
  anchors: Map<HTMLElement, Anchor>,
  stepped: boolean,
) {
  for (const [pane, unlift] of unlifts) {
    if (stage.contains(pane)) {
      unlift();
      unlifts.delete(pane);
    }
  }
  const moving = new Map<HTMLElement, HTMLElement[]>();
  const motion = MotionAnimation.start("window-movement", 1, 0);
  for (const [element, start] of shown) {
    tracks.get(element)?.cancel();
    tracks.delete(element);
    const pane = element.closest<HTMLElement>("[data-layout-pane-id]");
    if (motion.durationMs <= 0 || !element.isConnected || !pane || !stage.contains(pane)) continue;
    const anchor = anchors.get(pane) ?? "start";
    // Measured under the panes' slides and any tracked ancestor's, which all end at rest.
    const from =
      trackedEdge(element, start, anchor) - trackedEdge(element, trackedRect(element), anchor);
    if (Math.abs(from) < 0.5) continue;
    let rested = false;
    const run = playMotion(
      element,
      motion,
      (progress) => ({ transform: `translateX(${toDevicePixel(from * progress)}px)` }),
      () => {
        rested = true;
        if (tracks.get(element)?.motion !== motion) return;
        tracks.delete(element);
        if (!moving.get(pane)?.some((other) => tracks.has(other))) unlifts.get(pane)?.();
      },
      undefined,
      stepped,
    );
    if (rested) continue;
    tracks.set(element, run);
    moving.set(pane, [...(moving.get(pane) ?? []), element]);
  }
  for (const [pane, elements] of moving) {
    // Where the content starts, past the pane's box until it rests.
    const box = pane.getBoundingClientRect();
    let left = 0;
    let right = 0;
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      left = Math.max(left, box.left - rect.left);
      right = Math.max(right, rect.right - box.right);
    }
    if (left < 1 && right < 1) continue;
    const unlift = liftSlideClips(pane, elements);
    // Square: rounding a box wider than the pane cuts a wedge out of its own rounded corner.
    pane.style.clipPath = `inset(0 ${-right}px 0 ${-left}px)`;
    const restore = () => {
      if (unlifts.get(pane) !== restore) return;
      unlifts.delete(pane);
      pane.style.removeProperty("clip-path");
      unlift();
    };
    unlifts.set(pane, restore);
  }
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PaneBox extends Box {
  element: HTMLElement;
  paneId: string;
}

interface Slide {
  run: MotionRun;
  dx: number;
  dy: number;
  /** Runs once the pane rests, whichever slide gets it there. */
  onRest: (() => void) | undefined;
  /** Moves with it (an edge); removed when it rests or a retarget brings another. */
  rider: { edge: Edge; run: MotionRun } | undefined;
  /** Inside it, holding still on screen until it rests or retargets. */
  held: MotionRun[];
  /** Its end corners hold still (see `holdEnd`). */
  holdsEnd: boolean;
}

const slides = new WeakMap<HTMLElement, Slide>();

const translate = (dx: number, dy: number): Keyframe => ({
  transform: `translate(${toDevicePixel(dx)}px, ${toDevicePixel(dy)}px)`,
});

/** How far a new pane slides out from under its donor, in px. */
const OPEN_TRAVEL_PX = 48;

const ADJACENT_GAP_PX = 16;

/** The Panel animations setting's default, which the pane motions in the registry last. */
const DEFAULT_PANEL_MS = 150;

/** Whole device pixels, except beside the sidebar slide's smooth curve, which they would lag. */
let stepped = true;

function slide(
  element: HTMLElement,
  dx: number,
  dy: number,
  onRest?: () => void,
  /** The edge to ride along, made for the whole way the pane slides. */
  rider?: (dx: number, dy: number) => Edge | undefined,
): void {
  // A pane already sliding starts from where it shows now (niri's retarget)
  // and keeps the work owed when it rests.
  const running = slides.get(element);
  let rest = onRest;
  let kept: Edge | undefined;
  if (running) {
    // The pane's place moved (dx, dy) from where it shows; the edge it
    // carries moves with its place.
    running.rider?.edge.shift(-dx, -dy);
    const progress = running.run.value();
    dx += running.dx * progress;
    dy += running.dy * progress;
    running.run.cancel();
    running.rider?.run.cancel();
    for (const run of running.held) run.cancel();
    kept = running.rider?.edge;
    slides.delete(element);
    const earlier = running.onRest;
    if (earlier) rest = onRest ? () => (earlier(), onRest()) : earlier;
  }
  const motion = MotionAnimation.start("window-movement", 1, 0);
  if (motion.durationMs <= 0 || (toDevicePixel(dx) === 0 && toDevicePixel(dy) === 0)) {
    kept?.remove();
    rest?.();
    return;
  }
  const keyframe = (progress: number) => translate(dx * progress, dy * progress);
  // Without a new edge the donor's keeps riding until the pane rests.
  const made = rider?.(dx, dy);
  if (made) kept?.remove();
  const edge = made ?? kept;
  const entry: Slide = {
    dx,
    dy,
    onRest: rest,
    rider: edge
      ? {
          edge,
          run: playMotion(edge.element, motion, keyframe, undefined, undefined, stepped),
        }
      : undefined,
    held: [],
    holdsEnd: false,
    run: playMotion(
      element,
      motion,
      keyframe,
      () => {
        if (slides.get(element) !== entry) return;
        slides.delete(element);
        entry.rider?.edge.remove();
        entry.onRest?.();
      },
      undefined,
      stepped,
    ),
  };
  slides.set(element, entry);
}

const END_CORNERS = '[data-pane-bar-corner="end"], [data-pane-notch-corner="right"]';

/** Holds a sliding pane's `corner` still on screen until the pane rests, in step with its slide. */
function holdCorner(pane: HTMLElement, entry: Slide, corner: HTMLElement): void {
  if (corner.getAnimations().length > 0) return;
  const lead = pane.getAnimations()[0];
  const back = (progress: number) => translate(-entry.dx * progress, -entry.dy * progress);
  entry.held.push(playMotion(corner, entry.run.motion, back, undefined, undefined, stepped));
  const held = corner.getAnimations()[0];
  if (!lead || !held) return;
  if (lead.startTime !== null) held.startTime = lead.startTime;
  else if (lead.playState === "paused") {
    held.pause();
    held.currentTime = lead.currentTime;
  }
}

/** The window's end corner stays where a pane sliding in past the strip's end will rest. */
function holdEnd(pane: HTMLElement): void {
  const entry = slides.get(pane);
  if (!entry) return;
  entry.holdsEnd = true;
  for (const corner of pane.querySelectorAll<HTMLElement>(END_CORNERS)) {
    holdCorner(pane, entry, corner);
  }
}

/** For an end corner that mounts mid-slide (a lazy panel's toolbar): holds it like the rest. */
export function holdEndCornerWhileSliding(corner: HTMLElement | null): void {
  const pane = corner?.closest<HTMLElement>("[data-layout-pane-id]");
  const entry = pane ? slides.get(pane) : undefined;
  if (corner && pane && entry?.holdsEnd) holdCorner(pane, entry, corner);
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0) > 1;

type Side = "left" | "above" | "right" | "below";

interface Neighbour {
  /** Its box in the layout the adjacency is judged in. */
  box: Box;
  /** Its box in the other layout, when it has one. */
  other: Box | undefined;
}

/**
 * The pane beside `box` that gave it room (or takes its room back): its
 * donor. One that changed size along that side wins; then left, above,
 * right, below, the nearest on each side.
 */
function findDonor(
  box: Box,
  neighbours: Iterable<Neighbour>,
): { neighbour: Neighbour; side: Side; gap: number } | null {
  const order: Side[] = ["left", "above", "right", "below"];
  let best: { neighbour: Neighbour; side: Side; gap: number } | null = null;
  for (const neighbour of neighbours) {
    const other = neighbour.box;
    const gaps: [Side, number][] = [];
    if (overlaps(box.y, box.y + box.height, other.y, other.y + other.height)) {
      gaps.push(
        ["left", box.x - (other.x + other.width)],
        ["right", other.x - (box.x + box.width)],
      );
    }
    if (overlaps(box.x, box.x + box.width, other.x, other.x + other.width)) {
      gaps.push(
        ["above", box.y - (other.y + other.height)],
        ["below", other.y - (box.y + box.height)],
      );
    }
    for (const [side, gap] of gaps) {
      if (gap < -1 || gap > ADJACENT_GAP_PX) continue;
      const rank = (candidate: { neighbour: Neighbour; side: Side }) =>
        (candidate.neighbour.other &&
        resized(candidate.side, candidate.neighbour.box, candidate.neighbour.other)
          ? 0
          : 4) + order.indexOf(candidate.side);
      const candidate = { neighbour, side, gap };
      if (
        !best ||
        rank(candidate) < rank(best) ||
        (rank(candidate) === rank(best) && gap < best.gap)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/** The offset that tucks `box` under a donor of size `donor` on `side`. */
function tuckedUnder(side: Side, donor: Box, gap: number): { dx: number; dy: number } {
  switch (side) {
    case "left":
      return { dx: -(donor.width + gap), dy: 0 };
    case "right":
      return { dx: donor.width + gap, dy: 0 };
    case "above":
      return { dx: 0, dy: -(donor.height + gap) };
    case "below":
      return { dx: 0, dy: donor.height + gap };
  }
}

/** A donor's moving edge (see `makeEdge`). */
interface Edge {
  element: HTMLElement;
  remove: () => void;
  /** Moves it, filler and all, by (dx, dy) in stage px. */
  shift: (dx: number, dy: number) => void;
}

/** Move the donor edge with its neighboring pane; hold donor fill behind it so intermediate gaps
 * never expose chrome. */
function makeEdge(
  stage: HTMLElement,
  box: Box,
  side: Side,
  gap: number,
  radius: number,
  fill: number,
  above: boolean,
): Edge {
  const chrome = "var(--app-chrome-background)";
  const horizontal = side === "left" || side === "right";
  // A donor past the pane's far side (right, below) gets the near side's edge, mirrored.
  const far = side === "right" || side === "below";
  const swaps: Record<string, string> = horizontal
    ? { left: "right", right: "left" }
    : { top: "bottom", bottom: "top" };
  const mirror = (style: Record<string, string>) =>
    far
      ? Object.fromEntries(Object.entries(style).map(([key, value]) => [swaps[key] ?? key, value]))
      : style;
  const edge = document.createElement("div");
  edge.setAttribute("aria-hidden", "true");
  edge.dataset.paneMotionEdge = "";
  const depth = radius + gap + radius;
  const left = horizontal ? (far ? box.x + box.width - radius : box.x - gap - radius) : box.x;
  const top = horizontal ? box.y : far ? box.y + box.height - radius : box.y - gap - radius;
  Object.assign(edge.style, {
    position: "absolute",
    pointerEvents: "none",
    zIndex: above ? "49" : "-1",
    left: `${left}px`,
    top: `${top}px`,
    width: `${horizontal ? depth : box.width}px`,
    height: `${horizontal ? box.height : depth}px`,
  });
  const part = (style: Record<string, string>) => {
    const element = document.createElement("div");
    Object.assign(element.style, { position: "absolute", ...mirror(style) });
    edge.append(element);
  };
  // The gap, and behind the sliding pane's own rounded corners.
  part({
    background: `${chrome} var(--surface-grain)`,
    backgroundSize: "var(--surface-grain-size)",
    ...(horizontal
      ? { left: `${radius}px`, top: "0", width: `${gap + radius}px`, height: "100%" }
      : { top: `${radius}px`, left: "0", height: `${gap + radius}px`, width: "100%" }),
  });
  if (fill > 0) {
    // Over the filler, beside the gap: the donor's surface up to its corners.
    part({
      background: "var(--background)",
      ...(horizontal
        ? {
            left: "0",
            top: `${radius}px`,
            width: `${radius}px`,
            height: `calc(100% - ${radius * 2}px)`,
          }
        : {
            top: "0",
            left: `${radius}px`,
            height: `${radius}px`,
            width: `calc(100% - ${radius * 2}px)`,
          }),
    });
  }
  // Where it comes to rest on the donor's real corners, its arc stays clear of
  // their antialiased edge (inside it under the donor, outside it over it),
  // so taking it away changes no pixel.
  const [inner, outer] = above ? [radius + 0.5, radius + 1] : [radius - 1, radius - 0.5];
  const corner = (x: string, y: string) => {
    const flip = (at: string) => (at === "0" ? "100%" : "0");
    const at = far ? (horizontal ? `${flip(x)} ${y}` : `${x} ${flip(y)}`) : `${x} ${y}`;
    return `radial-gradient(circle ${radius}px at ${at}, ${fill > 0 ? "var(--background)" : "transparent"} ${inner}px, ${chrome} ${outer}px)`;
  };
  const square = { width: `${radius}px`, height: `${radius}px` };
  if (horizontal) {
    part({ ...square, left: "0", top: "0", background: corner("0", "100%") });
    part({ ...square, left: "0", bottom: "0", background: corner("0", "0") });
  } else {
    part({ ...square, left: "0", top: "0", background: corner("100%", "0") });
    part({ ...square, right: "0", top: "0", background: corner("0", "0") });
  }
  let filler: HTMLElement | null = null;
  if (fill > 0) {
    filler = document.createElement("div");
    filler.setAttribute("aria-hidden", "true");
    Object.assign(filler.style, {
      position: "absolute",
      pointerEvents: "none",
      zIndex: "-1",
      background: "var(--background)",
      left: `${horizontal && far ? left + depth - fill : left}px`,
      top: `${!horizontal && far ? top + depth - fill : top}px`,
      width: horizontal ? `${fill}px` : edge.style.width,
      height: horizontal ? edge.style.height : `${fill}px`,
    });
    stage.append(filler);
  }
  stage.append(edge);
  const nudge = (element: HTMLElement, dx: number, dy: number) => {
    element.style.left = `${Number.parseFloat(element.style.left) + dx}px`;
    element.style.top = `${Number.parseFloat(element.style.top) + dy}px`;
  };
  return {
    element: edge,
    remove: () => {
      edge.remove();
      filler?.remove();
    },
    shift: (dx, dy) => {
      nudge(edge, dx, dy);
      if (filler) nudge(filler, dx, dy);
    },
  };
}

/** A ghost draws nothing of its own, so a closed surface's pane, which React has already detached
 * and unmounted, rides inside it as it was until the ghost goes. */
function holdClosedPane(ghost: HTMLElement, pane: HTMLElement | undefined): void {
  if (!pane || pane.isConnected || ghost.childElementCount > 0) return;
  for (const [element, children] of closingChildren.get(pane) ?? []) {
    const now = element.childNodes;
    if (now.length !== children.length || children.some((child, i) => now[i] !== child)) {
      element.replaceChildren(...children);
    }
  }
  closingChildren.delete(pane);
  // Inserted again, a frame would load its page again.
  for (const frame of pane.querySelectorAll("iframe, webview")) frame.remove();
  for (const animation of pane.getAnimations({ subtree: true })) animation.cancel();
  // Nothing may find it as a live pane.
  delete pane.dataset.layoutTabId;
  delete pane.dataset.layoutPaneFocused;
  Object.assign(pane.style, { left: "0", top: "0", width: "100%", height: "100%" });
  ghost.append(pane);
}

/** A pane sliding past the strip's visible end while it rests there keeps the window's end corner
 * (the curve under its bar, or under its right notch with black chrome) where it rests, instead of
 * carrying it off or in from off screen. */
const passesEnd = (box: Box, dx: number, viewEnd: number) =>
  dx > 0 && Math.abs(box.x + box.width - viewEnd) < 1;

const boxOf = (element: HTMLElement): Box => ({
  x: element.offsetLeft,
  y: element.offsetTop,
  width: element.offsetWidth,
  height: element.offsetHeight,
});

const radiusOf = (element: HTMLElement) =>
  Number.parseFloat(getComputedStyle(element).borderTopRightRadius) || 0;

/**
 * What the strip's camera shows while the panes move, in stage px: from
 * where it shows now to where it lands, padded by a window either side.
 */
function visibleSpan(stage: HTMLElement): { left: number; right: number } {
  const scroller = stage.parentElement;
  if (!scroller) return { left: -Infinity, right: Infinity };
  const width = scroller.clientWidth;
  const shows = stripCameraPosition(scroller);
  return {
    left: Math.min(shows, scroller.scrollLeft) - width,
    right: Math.max(shows, scroller.scrollLeft) + 2 * width,
  };
}

/**
 * A slide that starts and ends past the same side of `view` is never seen;
 * at 50 columns most are. A pane already sliding still retargets.
 */
function unseen(box: PaneBox, dx: number, view: { left: number; right: number }): boolean {
  if (slides.has(box.element)) return false;
  const from = box.x + dx;
  if (box.x + box.width < view.left && from + box.width < view.left) return true;
  return box.x > view.right && from > view.right;
}

/** The donor changed size along the axis it shares with the sliding pane. */
function resized(side: Side, before: Box, now: Box): boolean {
  return side === "left" || side === "right"
    ? Math.abs(before.width - now.width) > 1
    : Math.abs(before.height - now.height) > 1;
}

/** The stage must be a stacking context. Workspace or viewport changes move panes 1:1, except a
 * sidebar toggle's; unframed lone panes never animate independently. */
export function usePaneMotion(
  stageRef: React.RefObject<HTMLElement | null>,
  key: string | null,
  framed: boolean,
  onGhostDone: (tabId: string) => void,
  placement: unknown,
  viewportWidth: number,
): void {
  // Settings > Appearance > Panel animations paces the panes and the strip's
  // camera for exactly its duration, as the sidebar slide; 0 not at all.
  const panelMs = useClientSettings((settings) => settings.panelAnimationDurationMs);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish committed animation settings to the imperative motion runtime before paint.
  useLayoutEffect(() => {
    configureMotion({ panelPace: panelMs / DEFAULT_PANEL_MS });
  }, [panelMs]);
  const previous = useRef<{
    key: string;
    viewportWidth: number;
    placement: unknown;
    boxes: Map<string, PaneBox>;
  } | null>(null);
  const ghosts = useRef(new WeakSet<HTMLElement>());
  const ghostDone = useEffectEvent(onGhostDone);
  const shownScroll = useRef<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Track the strip scroll the user last saw, which a layout change clamps before effects run.
  useLayoutEffect(() => {
    const scroller = stageRef.current?.parentElement;
    if (!scroller) return;
    const note = () => {
      shownScroll.current = scroller.scrollLeft;
    };
    note();
    scroller.addEventListener("scroll", note, { passive: true });
    return () => scroller.removeEventListener("scroll", note);
  }, [stageRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure committed pane boxes and start DOM animations before paint.
  useLayoutEffect(() => {
    const drop = takePaneDrop();
    const stage = stageRef.current;
    if (!stage || key === null) {
      previous.current = null;
      return;
    }
    // Every read happens here, before the slides below write a style:
    // reading after a write would lay the whole stage out again.
    const boxes = new Map<string, PaneBox>();
    const closing: { ghost: HTMLElement; box: Box }[] = [];
    let radius: number | null = null;
    for (const child of stage.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.layoutClosing !== undefined) {
        if (!ghosts.current.has(child)) closing.push({ ghost: child, box: boxOf(child) });
        if (radius === null) radius = radiusOf(child);
        continue;
      }
      const paneId = child.dataset.layoutPaneId;
      const tabId = child.dataset.layoutTabId;
      if (!paneId || !tabId) continue;
      // Layout boxes, which ignore the transforms in flight.
      boxes.set(tabId, { element: child, paneId, ...boxOf(child) });
      // Every pane shares the pane radius.
      if (radius === null) radius = radiusOf(child);
    }
    const before = previous.current;
    previous.current = { key, viewportWidth, placement, boxes };
    const animate =
      before !== null &&
      before.key === key &&
      framed &&
      (before.viewportWidth === viewportWidth || sidebarSlideStarting());
    stepped = !sidebarSlideStarting();
    const scroller = stage.parentElement;
    const shown = shownScroll.current;
    const camera =
      animate && scroller && shown !== null && stripCameraPosition(scroller) === scroller.scrollLeft
        ? shown - scroller.scrollLeft
        : 0;
    if (scroller) shownScroll.current = scroller.scrollLeft;
    const previousBoxes = new Map(
      [...(before?.boxes ?? [])].map(([id, box]) => [id, { ...box, x: box.x - camera }]),
    );
    const view = visibleSpan(stage);
    const viewEnd = scroller ? scroller.scrollLeft + scroller.clientWidth : Infinity;
    for (const { ghost, box: drawn } of closing) {
      ghosts.current.add(ghost);
      const box = { ...drawn, x: drawn.x - camera };
      const tabId = ghost.dataset.layoutClosing!;
      let edge: Edge | null = null;
      // Hidden the moment it rests, so it never shows again for the frame
      // before React drops it.
      const done = () => {
        ghost.style.visibility = "hidden";
        edge?.remove();
        ghostDone(tabId);
      };
      const donor =
        animate && before
          ? findDonor(
              box,
              [...previousBoxes]
                .filter(([id]) => id !== tabId)
                .map(([id, was]) => ({ box: was, other: boxes.get(id) })),
            )
          : null;
      if (!donor) {
        done();
        continue;
      }
      const { neighbour, side, gap } = donor;
      const now = neighbour.other;
      const past =
        now && (side === "left" || side === "above") && resized(side, neighbour.box, now)
          ? side === "left"
            ? { dx: now.x + now.width + gap - box.x, dy: 0 }
            : { dx: 0, dy: now.y + now.height + gap - box.y }
          : null;
      const coversPane =
        past !== null &&
        [...boxes.values()].some(
          (pane) =>
            overlaps(box.x + past.dx, box.x + past.dx + box.width, pane.x, pane.x + pane.width) &&
            overlaps(box.y + past.dy, box.y + past.dy + box.height, pane.y, pane.y + pane.height),
        );
      let offset: { dx: number; dy: number };
      if (past && !coversPane) {
        // The donor grows into its room: out past its new edge, over it.
        offset = past;
        ghost.style.zIndex = "50";
        edge = makeEdge(stage, box, side, gap, radius ?? 0, 0, true);
      } else {
        offset = tuckedUnder(side, neighbour.box, gap);
        ghost.style.zIndex = "-2";
      }
      const motion = MotionAnimation.start("window-movement", 0, 1);
      const keyframe = (progress: number) => translate(offset.dx * progress, offset.dy * progress);
      if (motion.durationMs > 0) holdClosedPane(ghost, before?.boxes.get(tabId)?.element);
      if (edge) playMotion(edge.element, motion, keyframe, undefined, undefined, true);
      if (camera === 0 && passesEnd(box, offset.dx, viewEnd)) {
        for (const corner of ghost.querySelectorAll<HTMLElement>(END_CORNERS)) {
          const back = (progress: number) => translate(-offset.dx * progress, 0);
          playMotion(corner, motion, back, undefined, undefined, true);
        }
      }
      playMotion(
        ghost,
        motion,
        (progress) => translate(offset.dx * progress - camera, offset.dy * progress),
        done,
        undefined,
        true,
      );
    }
    const tracked = shownBefore.get(stage);
    shownBefore.delete(stage);
    if (!before || !animate) return;
    const paneWas = new Map<string, PaneBox>();
    for (const box of previousBoxes.values()) paneWas.set(box.paneId, box);
    const wasOf = (tabId: string, box: PaneBox) => {
      const was = drop
        ? paneWas.get(box.paneId)
        : (previousBoxes.get(tabId) ?? paneWas.get(box.paneId));
      const inherited = was && was.element !== box.element ? slides.get(was.element) : undefined;
      if (!was || !inherited) return was;
      const owed = inherited.run.value();
      return { ...was, x: was.x + inherited.dx * owed, y: was.y + inherited.dy * owed };
    };
    const wasBy = new Map([...boxes].map(([tabId, box]) => [tabId, wasOf(tabId, box)]));
    const kept = (from: number, fromSize: number, to: number, toSize: number) =>
      drop && Math.abs(from + fromSize - to - toSize) < 1;
    const moved = (was: Box, box: Box) => ({
      dx: kept(was.x, was.width, box.x, box.width) ? 0 : was.x - box.x,
      dy: kept(was.y, was.height, box.y, box.height) ? 0 : was.y - box.y,
    });
    // Where each pane shows now against its new place, before any slide
    // below retargets it: its move plus what a running slide still owes.
    const shows = new Map<string, { dx: number; dy: number }>();
    for (const [tabId, box] of boxes) {
      const was = wasBy.get(tabId);
      const running = slides.get(box.element);
      const owed = running ? running.run.value() : 0;
      const move = was ? moved(was, box) : { dx: 0, dy: 0 };
      shows.set(tabId, {
        dx: move.dx + (running ? running.dx * owed : 0),
        dy: move.dy + (running ? running.dy * owed : 0),
      });
    }
    /** Hold the neighbor surface behind its moving edge when panes separate, so resizing or
     * reordering never exposes chrome. */
    const openingEdge =
      (box: PaneBox) =>
      (dx: number, dy: number): Edge | undefined => {
        const side: Side | null =
          Math.abs(dy) < 1 && Math.abs(dx) >= 1
            ? dx > 0
              ? "left"
              : "right"
            : Math.abs(dx) < 1 && Math.abs(dy) >= 1
              ? dy > 0
                ? "above"
                : "below"
              : null;
        if (side === null) return undefined;
        const horizontal = side === "left" || side === "right";
        let beside: { tabId: string; gap: number } | null = null;
        for (const [tabId, other] of boxes) {
          if (other === box) continue;
          const shared = horizontal
            ? overlaps(box.y, box.y + box.height, other.y, other.y + other.height)
            : overlaps(box.x, box.x + box.width, other.x, other.x + other.width);
          const gap =
            side === "left"
              ? box.x - (other.x + other.width)
              : side === "right"
                ? other.x - (box.x + box.width)
                : side === "above"
                  ? box.y - (other.y + other.height)
                  : other.y - (box.y + box.height);
          if (shared && gap >= -1 && (!beside || gap < beside.gap)) beside = { tabId, gap };
        }
        if (!beside) return undefined;
        // How far each shows from its place, toward the room between them.
        const toward = side === "left" || side === "above" ? 1 : -1;
        const travel = (horizontal ? dx : dy) * toward;
        const neighbour = shows.get(beside.tabId)!;
        const own = (horizontal ? neighbour.dx : neighbour.dy) * toward;
        // It slides at least as far: the two move together. One sliding in from
        // the other way leaves room of its own, which this does not cover.
        if (travel - own <= 1 || own < 0) return undefined;
        return makeEdge(stage, box, side, beside.gap, radius ?? 0, travel, false);
      };
    const panesBefore = new Set(paneWas.keys());
    const opened: Opening[] = [];
    const raised: HTMLElement[] = [];
    let moving = 1;
    const settle = () => {
      moving -= 1;
      if (moving > 0) return;
      for (const element of raised) {
        if (element.style.zIndex === "1") element.style.zIndex = "";
      }
    };
    for (const [tabId, box] of boxes) {
      const was = wasBy.get(tabId);
      if (!was && drop) {
        box.element.style.zIndex = "1";
        raised.push(box.element);
        continue;
      }
      if (!was) {
        if (previousBoxes.size === 0) continue;
        const donor = findDonor(
          box,
          [...boxes]
            .filter(([id, other]) => other !== box && panesBefore.has(other.paneId) && id !== tabId)
            .map(([id, other]) => ({ box: other, other: previousBoxes.get(id) })),
        );
        if (!donor) continue;
        const { neighbour, side, gap } = donor;
        const old = neighbour.other;
        if (old && (side === "left" || side === "above") && resized(side, old, neighbour.box)) {
          // The donor shrinks to make room: in from its old edge, the donor's
          // edge riding along.
          const offset =
            side === "left"
              ? { dx: old.x + old.width + gap - box.x, dy: 0 }
              : { dx: 0, dy: old.y + old.height + gap - box.y };
          if (unseen(box, offset.dx, view)) continue;
          const opening: Opening = { box, release: undefined };
          opened.push(opening);
          slide(
            box.element,
            offset.dx,
            offset.dy,
            () => opening.release?.(),
            (dx, dy) => makeEdge(stage, box, side, gap, radius ?? 0, Math.abs(dx + dy), false),
          );
          if (passesEnd(box, offset.dx, viewEnd)) holdEnd(box.element);
          continue;
        }
        // Otherwise a short way out from under it, beneath the panes moving off it.
        const offset = tuckedUnder(side, neighbour.box, gap);
        const length = Math.hypot(offset.dx, offset.dy);
        if (length > OPEN_TRAVEL_PX) {
          offset.dx *= OPEN_TRAVEL_PX / length;
          offset.dy *= OPEN_TRAVEL_PX / length;
        }
        if (unseen(box, offset.dx, view)) continue;
        box.element.style.zIndex = "-1";
        slide(box.element, offset.dx, offset.dy, () => {
          box.element.style.zIndex = "";
        });
        continue;
      }
      if (!panesBefore.has(box.paneId)) {
        box.element.style.zIndex = "1";
        raised.push(box.element);
      }
      const { dx, dy } = moved(was, box);
      if ((Math.abs(dx) >= 1 || Math.abs(dy) >= 1) && !unseen(box, dx, view)) {
        moving += 1;
        slide(box.element, dx, dy, settle, openingEdge(box));
      }
    }
    settle();
    if (!tracked || tracked.elements.size === 0) return;
    // A lane keeps its pane's left edge unless only the right one stays put on screen.
    const shift = stripLeft(stage) - tracked.strip;
    const anchors = new Map<HTMLElement, Anchor>();
    for (const [tabId, box] of boxes) {
      const was = wasBy.get(tabId);
      if (!was) continue;
      const left = Math.abs(was.x - box.x - shift) >= 1;
      const right = Math.abs(was.x + was.width - box.x - box.width - shift) >= 1;
      anchors.set(box.element, left && !right ? "end" : "start");
    }
    const wholePixels = stepped;
    // After the chat lanes re-measure for the new widths, so what they move lands once. Watching
    // the tracked elements: a sidebar toggle commits this from inside a resize observer.
    afterResizeObservers(
      () => {
        trackContent(stage, tracked.elements, anchors, wholePixels);
        // The chat lanes' re-measure is what moves a narrowed pane's details card out.
        if (tracked.held) return;
        for (const opening of opened) {
          const edge = slides.get(opening.box.element)?.rider?.edge;
          if (edge) opening.release = holdCoveredCards(tracked.cards, opening.box, edge.element);
        }
      },
      [...tracked.elements.keys()].filter((element) => element.isConnected),
    );
  }, [framed, key, placement, stageRef, viewportWidth]);
}
