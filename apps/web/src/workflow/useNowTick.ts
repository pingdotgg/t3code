import { useEffect, useState } from "react";

/**
 * The current time, refreshed on an interval — so time-derived UI (aging
 * badges, attention counts) crosses its thresholds without waiting for an
 * unrelated re-render.
 */
export const useNowTick = (intervalMs: number): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};
