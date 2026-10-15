import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a function with a fixed identity that always calls the latest `fn`.
 * Only call it from event handlers and effects; during render it would see the
 * previous commit's `fn`.
 *
 * Use it for event handlers in large, long-lived components. A `useCallback`
 * result keeps the render scope it was created in, and V8 shares one scope
 * between all closures of a render. When several memoized handlers change at
 * different times, each keeps an older scope holding older copies of the
 * others, and old renders pile up for as long as the component is mounted.
 */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
