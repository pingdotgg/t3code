/**
 * Gesture pieces from niri: the swipe tracker that turns a stream of deltas
 * into a velocity and a projected end (src/input/swipe_tracker.rs), the
 * rubber band past the first and last stop (src/rubber_band.rs), and how a
 * browser wheel stream maps onto a gesture.
 */

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
