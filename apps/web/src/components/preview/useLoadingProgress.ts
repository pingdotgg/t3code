import { useEffect, useRef, useState } from "react";

const TICK_INTERVAL_MS = 120;
const FADE_OUT_DELAY_MS = 220;
const SEED_PERCENT = 4;
const ASYMPTOTE_PERCENT = 90;
const APPROACH_FACTOR = 0.08;
const MIN_INCREMENT = 0.5;

/**
 * Indeterminate progress simulator for the preview chrome's loading bar.
 * Animates 0 → 90% asymptotically while `loading` is true, snaps to 100%
 * on release, then resets after a short pause.
 *
 * Uses a ref to thread the latest progress through interval ticks without
 * needing `loading` to retrigger the effect, which sidesteps the stale-
 * closure pitfalls of reading `progress` directly.
 */
export function useLoadingProgress(loading: boolean): number {
  const [progress, setProgress] = useState(0);
  const progressRef = useRef(0);
  progressRef.current = progress;

  useEffect(() => {
    if (!loading) {
      if (progressRef.current === 0) return;
      setProgress(100);
      const timer = window.setTimeout(() => setProgress(0), FADE_OUT_DELAY_MS);
      return () => window.clearTimeout(timer);
    }

    setProgress((value) => (value > 0 && value < 95 ? value : SEED_PERCENT));
    const interval = window.setInterval(() => {
      const current = progressRef.current;
      if (current >= ASYMPTOTE_PERCENT) return;
      const remaining = ASYMPTOTE_PERCENT - current;
      const increment = Math.max(MIN_INCREMENT, remaining * APPROACH_FACTOR);
      setProgress(Math.min(ASYMPTOTE_PERCENT, current + increment));
    }, TICK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [loading]);

  return progress;
}
