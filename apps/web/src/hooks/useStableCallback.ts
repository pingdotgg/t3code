import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Only call it from event handlers and effects; during render it would see the
 * previous commit's `fn`. A `useCallback` result keeps the render scope it was
 * created in, and V8 shares one scope between all closures of a render.
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
