/** Scale gesture velocity with the global slowdown. cssEasing samples the same curve so compositor
 * playback matches elapsed-time motion. */
import { resolveMotion, type MotionCurve, type MotionName } from "./registry";
import { Spring } from "./spring";

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (t: number, p1: number, p2: number) => {
    const omt = 1 - t;
    return 3 * omt * omt * t * p1 + 3 * omt * t * t * p2 + t * t * t;
  };
  return (x) => {
    if (x <= Number.EPSILON) return 0;
    if (x >= 1 - Number.EPSILON) return 1;
    let min = 0;
    let max = 1;
    for (let i = 0; i <= 30; i++) {
      const guess = (min + max) / 2;
      if (x < at(guess, x1, x2)) max = guess;
      else min = guess;
    }
    return at((min + max) / 2, y1, y2);
  };
}

function curveFunction(curve: MotionCurve): (x: number) => number {
  if (typeof curve === "object") return cubicBezier(...curve.cubicBezier);
  switch (curve) {
    case "linear":
      return (x) => x;
    case "ease-out-quad":
      return (x) => x * (2 - x);
    case "ease-out-cubic":
      return (x) => 1 + (x - 1) ** 3;
    case "ease-out-expo":
      return (x) => 1 - 2 ** (-10 * x);
  }
}

/** A bezier curve that leaves at `slope` (progress per unit of time) instead of its own start, so a
 * retarget keeps the speed it had; bounded so it never overshoots and turns back only a little. */
function leaving(curve: MotionCurve, slope: number): (x: number) => number {
  if (typeof curve !== "object" || !Number.isFinite(slope)) return curveFunction(curve);
  const [, , x2, y2] = curve.cubicBezier;
  const x1 = 1 / 3;
  return cubicBezier(x1, Math.min(1, Math.max(-1 / 3, slope * x1)), x2, y2);
}

export class MotionAnimation {
  private constructor(
    readonly from: number,
    readonly to: number,
    /** Real milliseconds until the value rests at `to`; 0 completes at once. */
    readonly durationMs: number,
    private readonly sample: (elapsedMs: number) => number,
  ) {}

  /**
   * `velocity` is in units per real second (a gesture's, or a running
   * animation's when it is retargeted). An easing handed one leaves at that
   * speed and keeps its own curve into the end.
   */
  static start(name: MotionName, from: number, to: number, velocity = 0): MotionAnimation {
    const { config, slowdown } = resolveMotion(name);
    if (config.kind === "off" || Math.abs(to - from) <= Number.EPSILON) {
      return new MotionAnimation(from, to, 0, () => to);
    }
    if (config.kind === "easing") {
      const durationMs = config.durationMs * slowdown;
      const y =
        velocity === 0
          ? curveFunction(config.curve)
          : leaving(config.curve, (velocity * durationMs) / 1000 / (to - from));
      return new MotionAnimation(from, to, durationMs, (elapsed) =>
        durationMs <= 0
          ? to
          : from + y(Math.min(1, Math.max(0, elapsed / durationMs))) * (to - from),
      );
    }
    const spring = new Spring(from, to, velocity * slowdown, config);
    const seconds = spring.duration();
    // A spring that never settles (no damping) is not one the registry allows.
    const durationMs = Number.isFinite(seconds) ? seconds * 1000 * slowdown : 0;
    // niri's guard against numerical instability.
    const range = (to - from) * 10;
    const low = Math.min(from - range, to + range);
    const high = Math.max(from - range, to + range);
    return new MotionAnimation(from, to, durationMs, (elapsed) =>
      Math.min(high, Math.max(low, spring.valueAt(elapsed / 1000 / slowdown))),
    );
  }

  /** The value `elapsedMs` real milliseconds after the start. */
  valueAt(elapsedMs: number): number {
    if (elapsedMs <= 0) return this.from;
    if (elapsedMs >= this.durationMs) return this.to;
    return this.sample(elapsedMs);
  }

  /** Units per real second, for handing a running animation's motion on. */
  velocityAt(elapsedMs: number): number {
    if (elapsedMs >= this.durationMs) return 0;
    const before = Math.max(0, elapsedMs - 1);
    const after = Math.min(this.durationMs, elapsedMs + 1);
    return ((this.sample(after) - this.sample(before)) / (after - before)) * 1000;
  }

  /**
   * The curve as a CSS `linear()` easing of progress from `from` (0) to `to`
   * (1), evenly sampled about every 8ms. A spring that overshoots goes past 1.
   */
  cssEasing(): string {
    const span = this.to - this.from;
    if (this.durationMs <= 0 || Math.abs(span) <= Number.EPSILON) return "linear";
    const steps = Math.min(120, Math.max(8, Math.ceil(this.durationMs / 8)));
    const points: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const progress =
        i === steps ? 1 : (this.sample((i / steps) * this.durationMs) - this.from) / span;
      points.push(String(Math.round(progress * 10000) / 10000));
    }
    return `linear(${points.join(", ")})`;
  }
}

/** Keyframes this many ms apart keep pace with any display: an 8 ms grid against a 120 Hz vsync
 * lands two steps in about one frame in nine, a visible hitch at speed. Finer costs more to start. */
export const FINE_STEP_MS = 2;

/** Hold sampled keyframes on whole device pixels to avoid resampling text mid-motion, every
 * `gridMs`; keep only the ones that move, and trim the tail once rounded positions stop changing. */
function steppedKeyframes(
  motion: MotionAnimation,
  keyframe: (value: number) => Keyframe,
  gridMs: number,
): { keyframes: Keyframe[]; durationMs: number } {
  const steps = Math.min(
    gridMs < 8 ? 600 : 240,
    Math.max(2, Math.ceil(motion.durationMs / gridMs)),
  );
  const values: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    values.push(
      keyframe(i === steps ? motion.to : motion.valueAt((i / steps) * motion.durationMs)),
    );
  }
  const same = (a: Keyframe, b: Keyframe) => JSON.stringify(a) === JSON.stringify(b);
  let last = steps;
  while (last > 0 && same(values[last - 1]!, values[steps]!)) last--;
  const keyframes: Keyframe[] = [];
  for (let i = 0; i <= last; i++) {
    // A step that shows the same pixels as the one before only holds it longer.
    if (i > 0 && i < last && same(values[i]!, values[i - 1]!)) continue;
    keyframes.push({ ...values[i], offset: last === 0 ? 1 : i / last, easing: "steps(1, end)" });
  }
  return { keyframes, durationMs: (last / steps) * motion.durationMs };
}

/** `px` rounded to the nearest device pixel. */
export function toDevicePixel(px: number): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.round(px * ratio) / ratio;
}

/** A `MotionAnimation` playing as a Web Animation on one element. */
export interface MotionRun {
  readonly motion: MotionAnimation;
  /** Where the value is on screen now. */
  value(): number;
  velocity(): number;
  /** Stops where it is; the element falls back to its own style. */
  cancel(): void;
  /**
   * Plays `motion` on the same Web Animation from this frame on. A new
   * animation would wait a frame to start, holding the element still; null
   * once this run has stopped.
   */
  retarget(
    motion: MotionAnimation,
    keyframe: (value: number) => Keyframe,
    onFinish?: () => void,
  ): MotionRun | null;
}

/** The element must already hold the final style. Leave no animation fill after completion so
 * nothing repaints at rest; instant motion finishes synchronously. */
export function playMotion(
  element: HTMLElement,
  motion: MotionAnimation,
  keyframe: (value: number) => Keyframe,
  onFinish?: () => void,
  startTime?: Animation["startTime"],
  /** Whole device pixels: `true` on an 8 ms grid, a number on a grid that many ms apart. */
  stepped: boolean | number = false,
): MotionRun {
  const grid = stepped === false ? null : stepped === true ? 8 : stepped;
  const framesOf = (next: MotionAnimation, keyframeOf: (value: number) => Keyframe) =>
    grid === null ? null : steppedKeyframes(next, keyframeOf, grid);
  const frames = framesOf(motion, keyframe);
  if (motion.durationMs <= 0 || (frames && frames.durationMs <= 0)) {
    onFinish?.();
    return finishedRun(motion);
  }
  const animation = frames
    ? element.animate(frames.keyframes, { duration: frames.durationMs })
    : element.animate([keyframe(motion.from), keyframe(motion.to)], {
        duration: motion.durationMs,
        easing: motion.cssEasing(),
      });
  // A camera triggered on keydown can begin on the current document frame.
  // An inactive timeline keeps the browser's normal pending-start behavior.
  if (startTime != null) animation.startTime = startTime;
  const runOf = (played: MotionAnimation, finish: (() => void) | undefined): MotionRun => {
    // Elapsed time once it stopped: at the end, or wherever it was cancelled.
    let stoppedAt: number | null = null;
    const elapsed = () => stoppedAt ?? Number(animation.currentTime ?? 0);
    animation.onfinish = () => {
      stoppedAt = played.durationMs;
      finish?.();
    };
    return {
      motion: played,
      value: () => played.valueAt(elapsed()),
      velocity: () => played.velocityAt(elapsed()),
      cancel: () => {
        if (stoppedAt !== null) return;
        stoppedAt = elapsed();
        animation.onfinish = null;
        animation.cancel();
      },
      retarget: (next, keyframeOf, nextFinish) => {
        if (stoppedAt !== null) return null;
        const nextFrames = framesOf(next, keyframeOf);
        if (next.durationMs <= 0 || (nextFrames && nextFrames.durationMs <= 0)) {
          stoppedAt = elapsed();
          animation.onfinish = null;
          animation.cancel();
          nextFinish?.();
          return finishedRun(next);
        }
        // Handed over: this run reads as stopped where it was.
        stoppedAt = elapsed();
        const effect = animation.effect as KeyframeEffect;
        if (nextFrames) {
          effect.setKeyframes(nextFrames.keyframes);
          effect.updateTiming({ duration: nextFrames.durationMs });
        } else {
          effect.setKeyframes([keyframeOf(next.from), keyframeOf(next.to)]);
          effect.updateTiming({ duration: next.durationMs, easing: next.cssEasing() });
        }
        // A running animation sought to 0 carries on from this frame.
        animation.currentTime = 0;
        return runOf(next, nextFinish);
      },
    };
  };
  return runOf(motion, onFinish);
}

function finishedRun(motion: MotionAnimation): MotionRun {
  return {
    motion,
    value: () => motion.to,
    velocity: () => 0,
    cancel: () => {},
    retarget: () => null,
  };
}
