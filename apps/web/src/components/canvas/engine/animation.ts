import type { CanvasAnimation, CanvasEasing, CanvasKeyframe } from "@t3tools/contracts";

import { mixColor, parseColor } from "./color";

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 6; i++) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-5) break;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    return sampleY(Math.min(1, Math.max(0, t)));
  };
}

const EASE = cubicBezier(0.25, 0.1, 0.25, 1);
const EASE_IN = cubicBezier(0.42, 0, 1, 1);
const EASE_OUT = cubicBezier(0, 0, 0.58, 1);
const EASE_IN_OUT = cubicBezier(0.42, 0, 0.58, 1);

/** Damped spring approximation: ~9% overshoot, settles by t = 1. */
const spring = (t: number) => 1 - Math.exp(-6 * t) * Math.cos(2 * Math.PI * 1.25 * t);

function applyEasing(easing: CanvasEasing | undefined, t: number): number {
  switch (easing ?? "ease") {
    case "linear":
      return t;
    case "ease":
      return EASE(t);
    case "ease-in":
      return EASE_IN(t);
    case "ease-out":
      return EASE_OUT(t);
    case "ease-in-out":
      return EASE_IN_OUT(t);
    case "spring":
      return spring(t);
  }
}

const sortedKeyframes = new WeakMap<ReadonlyArray<CanvasKeyframe>, ReadonlyArray<CanvasKeyframe>>();

function keyframesOf(animation: CanvasAnimation) {
  let sorted = sortedKeyframes.get(animation.keyframes);
  if (!sorted) {
    sorted = animation.keyframes.toSorted((a, b) => a.offset - b.offset);
    sortedKeyframes.set(animation.keyframes, sorted);
  }
  return sorted;
}

const numeric = (value: number | string) =>
  typeof value === "number" ? value : Number.parseFloat(value);
const colorOf = (value: number | string) =>
  typeof value === "string" ? parseColor(value) : value >>> 0;

/** Total active time in ms, `Infinity` when looping forever. */
export function animationEndMs(animation: CanvasAnimation): number {
  const iterations =
    animation.loop === true ? Infinity : typeof animation.loop === "number" ? animation.loop : 1;
  return (animation.delayMs ?? 0) + Math.max(0, animation.durationMs) * Math.max(1, iterations);
}

/**
 * Samples an animation at `elapsedMs` since it started. Numeric properties
 * return a number; `fill` returns a straight packed color. Holds the first
 * keyframe during the delay and the last after it finishes (fill-mode both).
 */
export function sampleAnimation(animation: CanvasAnimation, elapsedMs: number): number {
  const frames = keyframesOf(animation);
  const isColor = animation.property === "fill";
  if (frames.length === 0) return Number.NaN;
  const first = frames[0]!;
  if (frames.length === 1) return isColor ? colorOf(first.value) : numeric(first.value);
  const duration = Math.max(1, animation.durationMs);
  const iterations =
    animation.loop === true ? Infinity : typeof animation.loop === "number" ? animation.loop : 1;
  const time = (elapsedMs - (animation.delayMs ?? 0)) / duration;
  let progress: number;
  if (time <= 0) progress = 0;
  else if (time >= iterations) {
    const last = Math.max(0, Math.ceil(iterations) - 1);
    progress = animation.alternate === true && last % 2 === 1 ? 0 : 1;
  } else {
    const iteration = Math.floor(time);
    progress = time - iteration;
    if (animation.alternate === true && iteration % 2 === 1) progress = 1 - progress;
  }
  let k = 0;
  while (k < frames.length - 2 && frames[k + 1]!.offset <= progress) k++;
  const from = frames[k]!;
  const to = frames[k + 1]!;
  if (progress <= from.offset) return isColor ? colorOf(from.value) : numeric(from.value);
  if (progress >= to.offset) return isColor ? colorOf(to.value) : numeric(to.value);
  const local = applyEasing(from.easing, (progress - from.offset) / (to.offset - from.offset));
  if (isColor) return mixColor(colorOf(from.value), colorOf(to.value), local);
  const a = numeric(from.value);
  return a + (numeric(to.value) - a) * local;
}
