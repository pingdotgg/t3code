import { useEffect, useRef, useState } from "react";

/** Cubic ease-out: fast to start, settles without overshoot. */
export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clamped) ** 3;
}

/**
 * Value shown at `elapsedMs` into a tween from `from` to `to`.
 * Snaps exactly to `to` once the duration has elapsed so a tween can never
 * leave a number a fraction short of its real value.
 */
export function animatedNumberAt(
  from: number,
  to: number,
  elapsedMs: number,
  durationMs: number,
): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  return from + (to - from) * easeOutCubic(elapsedMs / durationMs);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Tweens toward `target` whenever it changes, then stops.
 *
 * One `requestAnimationFrame` loop runs per changed value for the duration and
 * is torn down on arrival, so an idle page schedules no frames at all. Reduced
 * motion and the very first value both land instantly.
 */
export function useAnimatedNumber(target: number, durationMs = 420): number {
  const [value, setValue] = useState(target);
  const frameRef = useRef<number | null>(null);
  const valueRef = useRef(target);
  valueRef.current = value;

  useEffect(() => {
    if (valueRef.current === target) return;
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      setValue(target);
      return;
    }

    const from = valueRef.current;
    const startMs = performance.now();
    const step = (nowMs: number) => {
      const elapsedMs = nowMs - startMs;
      const next = animatedNumberAt(from, target, elapsedMs, durationMs);
      setValue(next);
      frameRef.current = elapsedMs >= durationMs ? null : requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [durationMs, target]);

  return value;
}
