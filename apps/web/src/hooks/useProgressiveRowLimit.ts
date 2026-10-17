import { startTransition, useEffect, useState } from "react";

/** Paint initial rows first, then render the rest without blocking input. */
export function useProgressiveRowLimit(initial: number): number {
  const [limit, setLimit] = useState(initial);
  useEffect(() => {
    if (limit === Number.POSITIVE_INFINITY) return;
    const frame = requestAnimationFrame(() =>
      startTransition(() => setLimit(Number.POSITIVE_INFINITY)),
    );
    return () => cancelAnimationFrame(frame);
  }, [limit]);
  return limit;
}
