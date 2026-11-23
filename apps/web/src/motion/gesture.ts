/**
 * Gesture pieces from niri: the swipe tracker that turns a stream of deltas
 * into a velocity and a projected end (src/input/swipe_tracker.rs), the
 * rubber band past the first and last stop (src/rubber_band.rs), and how a
 * browser wheel stream maps onto a gesture.
 */
import { isMacPlatform } from "../lib/utils";

/** Deltas older than this no longer count toward the velocity. */
const HISTORY_LIMIT_MS = 150;
/** libinput's touchpad deceleration per ms; the projection assumes it. */
const DECELERATION_TOUCHPAD = 0.997;

export class SwipeTracker {
  private history: { delta: number; time: number }[] = [];
  /** Summed travel since the gesture began. */
  pos = 0;

  push(delta: number, time: number): void {
    const last = this.history.at(-1);
    if (last && time < last.time) return;
    this.history.push({ delta, time });
    this.pos += delta;
    while (this.history.length > 0 && time > this.history[0]!.time + HISTORY_LIMIT_MS) {
      this.history.shift();
    }
  }

  /** Travel per second over the last 150ms. */
  velocity(): number {
    const first = this.history[0];
    const last = this.history.at(-1);
    if (!first || !last || last.time === first.time) return 0;
    const total = this.history.reduce((sum, event) => sum + event.delta, 0);
    return (total / (last.time - first.time)) * 1000;
  }

  /** Where the travel would coast to: about a third of a second at this velocity. */
  projectedEndPos(): number {
    return this.pos - this.velocity() / (1000 * Math.log(DECELERATION_TOUCHPAD));
  }
}

/** niri's rubber band: slope `stiffness` at the edge, never past `limit`. */
export interface RubberBand {
  readonly stiffness: number;
  readonly limit: number;
}

/** Past the first or last workspace: 0.1 of overpull shows 0.025, at most 0.05. */
export const WORKSPACE_RUBBER_BAND: RubberBand = { stiffness: 0.5, limit: 0.05 };

function band({ stiffness: c, limit: d }: RubberBand, x: number): number {
  return (1 - 1 / ((x * c) / d + 1)) * d;
}

export function rubberBandClamp(rubber: RubberBand, min: number, max: number, x: number): number {
  const clamped = Math.min(max, Math.max(min, x));
  return clamped + Math.sign(x - clamped) * band(rubber, Math.abs(x - clamped));
}

/** How much of a velocity survives the band at `x`, for the release spring. */
export function rubberBandClampDerivative(
  rubber: RubberBand,
  min: number,
  max: number,
  x: number,
): number {
  if (min <= x && x <= max) return 1;
  const diff = Math.abs(x - Math.min(max, Math.max(min, x)));
  const { stiffness: c, limit: d } = rubber;
  return (c * d * d) / (c * diff + d) ** 2;
}

/** Legacy wheelDeltaY distinguishes discrete 120-unit notches from precise trackpad deltas;
 * ambiguous pixel events remain swipe gestures. */
export function isDiscreteWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true;
  const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (typeof legacy !== "number" || legacy === 0 || legacy % 120 !== 0) return false;
  return legacy !== -3 * event.deltaY && legacy !== -event.deltaY;
}

/** Wheel deltas in px; a notch in lines or pages counts as one screenful step anyway. */
export function wheelDeltaPx(delta: number, event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 40;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * 800;
  return delta;
}

const WHEEL_EASE_MS = 40;
interface WheelChase {
  target: number;
  time: number;
  position: number;
  max: number;
}
const wheelChases = new Map<HTMLElement, WheelChase>();
let wheelChaseFrame: number | null = null;
let reducedMotion: MediaQueryList | null = null;
const wheelStreams = new WeakMap<Window, { last: number; direct: boolean }>();
const DISPLAY_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

function stepWheelChases(time: number): void {
  wheelChaseFrame = null;
  const updates: { element: HTMLElement; state: WheelChase; next: number }[] = [];
  for (const [element, state] of wheelChases) {
    if (!element.isConnected || Math.abs(element.scrollLeft - state.position) > 1) {
      wheelChases.delete(element);
      continue;
    }
    state.target = Math.min(state.target, state.max);
    const next = wheelChaseStep(state.position, state.target, Math.max(0, time - state.time));
    state.time = Math.max(time, state.time);
    state.position = next;
    updates.push({ element, state, next });
  }
  for (const { element, state, next } of updates) {
    element.scrollLeft = next;
    if (next === state.target) wheelChases.delete(element);
  }
  if (wheelChases.size > 0) {
    wheelChaseFrame = requestAnimationFrame(stepWheelChases);
  }
}

function wholeTicks(ticks: number): boolean {
  return Math.round(ticks) !== 0 && Math.abs(ticks - Math.round(ticks)) < 0.05;
}

function wheelSource(event: WheelEvent): "notched" | "trackpad" | "either" {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return "notched";
  const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  const { wheelDeltaX = 0, wheelDeltaY = 0 } = event as WheelEvent & {
    wheelDeltaX?: number;
    wheelDeltaY?: number;
  };
  const [delta, other, legacy, otherLegacy] = sideways
    ? [event.deltaX, event.deltaY, wheelDeltaX, wheelDeltaY]
    : [event.deltaY, event.deltaX, wheelDeltaY, wheelDeltaX];
  if (other !== 0 || otherLegacy !== 0) return "trackpad";
  if (Math.abs(legacy + delta) <= 1) return "trackpad";
  if (Math.abs(legacy + 3 * delta) <= 1) {
    return wholeTicks(legacy / 120) ? "either" : "trackpad";
  }
  if (wholeTicks(legacy / 120)) return "notched";
  const ratio = (event.view ?? window).devicePixelRatio || 1;
  const zoomed = DISPLAY_SCALES.some((scale) => wholeTicks((legacy * ratio) / (120 * scale)));
  return zoomed ? "notched" : "trackpad";
}

function easesWheel(event: WheelEvent): boolean {
  const view = event.view ?? window;
  let stream = wheelStreams.get(view);
  if (!stream) {
    stream = { last: Number.NEGATIVE_INFINITY, direct: false };
    wheelStreams.set(view, stream);
  }
  if (event.timeStamp - stream.last > WHEEL_STREAM_IDLE_MS) stream.direct = false;
  stream.last = event.timeStamp;
  if (wheelSource(event) === "trackpad") stream.direct = true;
  return !stream.direct;
}

export function wheelScrollTarget(
  position: number,
  pending: number | undefined,
  delta: number,
  max: number,
): number {
  const base =
    pending !== undefined && Math.sign(pending - position) === Math.sign(delta)
      ? pending
      : position;
  return Math.min(Math.max(base + delta, 0), Math.max(0, max));
}

export function wheelChaseStep(position: number, target: number, elapsedMs: number): number {
  const next = target + (position - target) * Math.exp(-elapsedMs / WHEEL_EASE_MS);
  return Math.abs(target - next) < 0.5 ? target : next;
}

export function scrollLeftByWheel(element: HTMLElement, event: WheelEvent, delta: number): boolean {
  const position = element.scrollLeft;
  const max = element.scrollWidth - element.clientWidth;
  reducedMotion ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  const chase = wheelChases.get(element);
  const direct = !easesWheel(event);
  const clampedMax = Math.max(0, max);
  if (direct || reducedMotion.matches) {
    element.scrollLeft = position + delta;
    if (reducedMotion.matches) {
      wheelChases.delete(element);
    } else if (chase) {
      chase.position = element.scrollLeft;
      chase.max = clampedMax;
      chase.target = Math.min(Math.max(chase.target + delta, 0), clampedMax);
    }
    return Math.min(Math.max(position + delta, 0), max) !== position;
  }
  const target = wheelScrollTarget(position, chase?.target, delta, max);
  if (chase) {
    chase.max = clampedMax;
    chase.target = target;
    return true;
  }
  if (target === position) return false;
  wheelChases.set(element, { target, time: performance.now(), position, max: clampedMax });
  wheelChaseFrame ??= requestAnimationFrame(stepWheelChases);
  return true;
}

function sidewaysScroller(element: Element): { scrolls: boolean; stopsChain: boolean } {
  const style = getComputedStyle(element);
  const scroller = style.overflowX === "auto" || style.overflowX === "scroll";
  return {
    scrolls: scroller && element.scrollWidth > element.clientWidth,
    // Chromium ends a scroll chain at a scroller that contains its overscroll, even one with
    // nothing to scroll (a short code block): the swipe moves nothing past it.
    stopsChain: scroller && style.overscrollBehaviorX !== "auto",
  };
}

/**
 * Who moves the strip for a sideways swipe along `path`: nobody when a scroller on the way can
 * scroll sideways itself; the browser natively when the scroll chain reaches the strip; script
 * when a scroller with nothing to scroll ends the chain first.
 */
export function sidewaysWheelStripScroll(
  path: readonly EventTarget[],
  strip: Element,
  deltaX: number,
  deltaY: number,
): "native" | "script" | null {
  if (Math.abs(deltaX) <= Math.abs(deltaY)) return null;
  let stopped = false;
  for (const node of path) {
    if (node === strip) {
      if (!sidewaysScroller(strip).scrolls) return null;
      return stopped ? "script" : "native";
    }
    if (!(node instanceof Element)) continue;
    const { scrolls, stopsChain } = sidewaysScroller(node);
    if (scrolls) return null;
    stopped ||= stopsChain;
  }
  return null;
}

/** Row controls outside the viewport forward sideways input to their tabs. */
export function scrollTabStripFromRow(event: WheelEvent, strip: HTMLElement): void {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const delta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
  if (!delta || (!event.shiftKey && Math.abs(delta) <= Math.abs(event.deltaY))) return;
  if (strip.scrollWidth <= strip.clientWidth) return;
  // Keep native gesture notifications over the viewport for history-swipe navigation.
  if (event.composedPath().includes(strip) && event.deltaX !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  scrollLeftByWheel(strip, event, wheelDeltaPx(delta, event));
}

/**
 * The browser sends a trackpad swipe as wheel events with no begin or end,
 * and keeps sending the OS's momentum after the fingers lift. A stream ends
 * after this long without an event: fingers resting or lifted, momentum
 * spent. Events while fingers move or momentum runs come every 8-17ms.
 */
export const WHEEL_STREAM_IDLE_MS = 120;
/**
 * The fingers count as lifted once the stream's velocity falls under this
 * share of its peak: momentum only ever decays, so the rest of the stream
 * is the tail. Pressed past the last stop, any slowing counts (`EDGE_SHARE`).
 * Below `TAIL_MIN_PEAK` (px/s) a stream is a slow drag that ends on idle alone.
 */
const TAIL_SHARE = 0.4;
const EDGE_SHARE = 0.8;
const TAIL_MIN_PEAK = 1200;

/** Only a reversal starts a new gesture inside a momentum stream. Swallow the tail so coalesced or
 * jittery deltas cannot trigger a second step. */
export class WheelTail {
  private tracker = new SwipeTracker();
  private peak = 0;
  private sign = 0;
  private lifted = false;

  /** `pastEdge`: the gesture already overshoots its last stop. */
  push(delta: number, time: number, pastEdge = false): "gesture" | "lifted" | "tail" | "resumed" {
    const sign = Math.sign(delta);
    this.tracker.push(delta, time);
    const speed = Math.abs(this.tracker.velocity());
    if (this.lifted) {
      if (sign !== 0 && sign !== this.sign && Math.abs(delta) >= 2) {
        this.reset(sign, time, delta);
        return "resumed";
      }
      return "tail";
    }
    if (sign !== 0) this.sign ||= sign;
    this.peak = Math.max(this.peak, speed);
    if (this.peak >= TAIL_MIN_PEAK && speed < this.peak * (pastEdge ? EDGE_SHARE : TAIL_SHARE)) {
      this.lifted = true;
      return "lifted";
    }
    return "gesture";
  }

  private reset(sign: number, time: number, delta: number): void {
    this.tracker = new SwipeTracker();
    this.tracker.push(delta, time);
    this.peak = 0;
    this.sign = sign;
    this.lifted = false;
  }
}

/**
 * Elements that scroll on the wheel by themselves, with no overflow to read
 * (a terminal's canvas): whether they would still move `dy`'s way. A plain
 * vertical swipe over one switches workspaces only when this says no.
 */
const wheelScrollers = new WeakMap<object, (dy: number) => boolean>();

export function setWheelScroller(
  element: object,
  canScroll: ((dy: number) => boolean) | null,
): void {
  if (canScroll) wheelScrollers.set(element, canScroll);
  else wheelScrollers.delete(element);
}

/** The chord that hands the wheel to the layout: alt+cmd on a Mac, ctrl+alt elsewhere. */
export function layoutChordHeld(event: MouseEvent | KeyboardEvent): boolean {
  return isMacPlatform(navigator.platform)
    ? event.metaKey && event.altKey
    : event.ctrlKey && event.altKey;
}

/**
 * Listens to wheel events on `target`, able to cancel them only while the layout chord is held or
 * `keep()` says a gesture it owns is still going. A cancelable wheel listener makes the compositor
 * wait for the main thread before it scrolls anything under it, so otherwise it listens passively.
 * Call `refresh` when `keep()` changes.
 */
export function listenLayoutWheel(
  target: EventTarget,
  listener: (event: WheelEvent) => void,
  { capture = false, keep = () => false }: { capture?: boolean; keep?: () => boolean } = {},
): { stop: () => void; refresh: () => void } {
  let held = false;
  let blocking: boolean | null = null;
  const wheel = (event: Event) => {
    // A chord pressed while the window was away sent no keydown: cancel from the next gesture on.
    if (!blocking && layoutChordHeld(event as WheelEvent)) {
      held = true;
      refresh();
    }
    listener(event as WheelEvent);
  };
  const refresh = () => {
    const next = held || keep();
    if (next === blocking) return;
    if (blocking !== null) target.removeEventListener("wheel", wheel, capture);
    blocking = next;
    target.addEventListener("wheel", wheel, { capture, passive: !next });
  };
  const onKey = (event: KeyboardEvent) => {
    held = layoutChordHeld(event);
    refresh();
  };
  const onBlur = () => {
    held = false;
    refresh();
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("blur", onBlur);
  refresh();
  return {
    stop: () => {
      target.removeEventListener("wheel", wheel, capture);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
    },
    refresh,
  };
}
