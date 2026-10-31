/** Translate on whole device pixels without scaling or fades. Change sizes once so live timelines
 * never lay out per frame. */
import { useEffectEvent, useLayoutEffect, useRef } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { MotionAnimation, playMotion, toDevicePixel, type MotionRun } from "./animation";
import { configureMotion } from "./registry";
import { stripCameraPosition } from "./stripCamera";

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
}

const slides = new WeakMap<HTMLElement, Slide>();

const translate = (dx: number, dy: number): Keyframe => ({
  transform: `translate(${toDevicePixel(dx)}px, ${toDevicePixel(dy)}px)`,
});

/** How far a new pane slides out from under its donor, in px. */
const OPEN_TRAVEL_PX = 48;

/** The Panel animations setting's default, which plays niri's springs as they are. */
const DEFAULT_PANEL_MS = 150;

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
    kept = running.rider?.edge;
    slides.delete(element);
    const earlier = running.onRest;
    if (earlier) rest = onRest ? () => (earlier(), onRest()) : earlier;
  }
  const motion = MotionAnimation.start("window-movement", 1, 0);
  if (motion.durationMs <= 0 || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) {
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
          run: playMotion(edge.element, motion, keyframe, undefined, undefined, true),
        }
      : undefined,
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
      true,
    ),
  };
  slides.set(element, entry);
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
      if (gap < -1) continue;
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

/** The stage must be a stacking context. Workspace or viewport changes move panes 1:1; unframed lone
 * panes never animate independently. */
export function usePaneMotion(
  stageRef: React.RefObject<HTMLElement | null>,
  key: string | null,
  framed: boolean,
  onGhostDone: (tabId: string) => void,
  placement: unknown,
): void {
  // Settings > Appearance > Panel animations paces the panes and the strip's
  // camera: 150ms plays niri's springs as they are, 300ms twice as slow, 0
  // not at all.
  const panelMs = useClientSettings((settings) => settings.panelAnimationDurationMs);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish committed animation settings to the imperative motion runtime before paint.
  useLayoutEffect(() => {
    configureMotion({ panelPace: panelMs / DEFAULT_PANEL_MS });
  }, [panelMs]);
  const previous = useRef<{
    key: string;
    placement: unknown;
    boxes: Map<string, PaneBox>;
  } | null>(null);
  const ghosts = useRef(new WeakSet<HTMLElement>());
  const ghostDone = useEffectEvent(onGhostDone);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure committed pane boxes and start DOM animations before paint.
  useLayoutEffect(() => {
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
    const view = visibleSpan(stage);
    const before = previous.current;
    previous.current = { key, placement, boxes };
    const animate = before !== null && before.key === key && framed;
    for (const { ghost, box } of closing) {
      ghosts.current.add(ghost);
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
              [...before.boxes]
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
      let offset: { dx: number; dy: number };
      if (now && (side === "left" || side === "above") && resized(side, neighbour.box, now)) {
        // The donor grows into its room: out past its new edge, over it.
        offset =
          side === "left"
            ? { dx: now.x + now.width + gap - box.x, dy: 0 }
            : { dx: 0, dy: now.y + now.height + gap - box.y };
        ghost.style.zIndex = "50";
        edge = makeEdge(stage, box, side, gap, radius ?? 0, 0, true);
      } else {
        offset = tuckedUnder(side, neighbour.box, gap);
        ghost.style.zIndex = "-2";
      }
      const motion = MotionAnimation.start("window-movement", 0, 1);
      const keyframe = (progress: number) => translate(offset.dx * progress, offset.dy * progress);
      if (edge) playMotion(edge.element, motion, keyframe, undefined, undefined, true);
      playMotion(ghost, motion, keyframe, done, undefined, true);
    }
    if (!before || !animate) return;
    // Where each pane shows now against its new place, before any slide
    // below retargets it: its move plus what a running slide still owes.
    const shows = new Map<string, { dx: number; dy: number }>();
    for (const [tabId, box] of boxes) {
      const was = before.boxes.get(tabId);
      const running = slides.get(box.element);
      const owed = running ? running.run.value() : 0;
      shows.set(tabId, {
        dx: (was ? was.x - box.x : 0) + (running ? running.dx * owed : 0),
        dy: (was ? was.y - box.y : 0) + (running ? running.dy * owed : 0),
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
    const panesBefore = new Set([...before.boxes.values()].map((box) => box.paneId));
    for (const [tabId, box] of boxes) {
      const was = before.boxes.get(tabId);
      if (!was) {
        if (panesBefore.has(box.paneId) || before.boxes.size === 0) continue;
        const donor = findDonor(
          box,
          [...boxes]
            .filter(([id, other]) => other !== box && panesBefore.has(other.paneId) && id !== tabId)
            .map(([id, other]) => ({ box: other, other: before.boxes.get(id) })),
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
          slide(box.element, offset.dx, offset.dy, undefined, (dx, dy) =>
            makeEdge(stage, box, side, gap, radius ?? 0, Math.abs(dx + dy), false),
          );
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
      const dx = was.x - box.x;
      const dy = was.y - box.y;
      if ((Math.abs(dx) >= 1 || Math.abs(dy) >= 1) && !unseen(box, dx, view)) {
        slide(box.element, dx, dy, undefined, openingEdge(box));
      }
    }
  }, [framed, key, placement, stageRef]);
}
