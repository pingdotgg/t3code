import { useLayoutEffect, useRef, useState } from "react";

/**
 * Only call it from event handlers and effects; during render it would see the
 * previous commit's `fn`. The forwarder is created once so its identity does not
 * depend on the React Compiler, and it keeps no render scope alive: V8 shares one
 * scope between all closures of a render.
 */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  const [stable] = useState(
    () =>
      (...args: Args) =>
        latest.current(...args),
  );
  return stable;
}
