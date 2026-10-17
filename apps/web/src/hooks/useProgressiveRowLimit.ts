import { startTransition, useEffect, useState } from "react";

/**
 * How many rows of a long list to render. The first paint gets `initial`
 * rows and the rest follow `step` at a time, one transition per frame. A
 * single transition for the whole remainder still commits hundreds of
 * controls at once.
 */
export function useProgressiveRowLimit(initial: number, total: number, step = initial): number {
  const [limit, setLimit] = useState(initial);
  useEffect(() => {
    if (limit >= total) return;
    const frame = requestAnimationFrame(() =>
      startTransition(() => setLimit((current) => Math.min(total, current + step))),
    );
    return () => cancelAnimationFrame(frame);
  }, [limit, step, total]);
  return limit;
}
