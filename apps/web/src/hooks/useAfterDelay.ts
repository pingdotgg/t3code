import { useEffect, useState } from "react";

/**
 * True once `active` has stayed true for `delayMs`, and false again as soon as
 * it stops, so a placeholder never flashes for a load that finishes quickly.
 */
export function useAfterDelay(active: boolean, delayMs: number) {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}
