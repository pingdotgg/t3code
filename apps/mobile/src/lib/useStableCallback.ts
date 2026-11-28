import { useInsertionEffect, useRef, useState } from "react";

/** Call only from handlers and effects; render sees the previous commit's fn. */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);
  // Insertion effects run before every layout effect in the commit, so a
  // child's layout effect already calls this render's fn.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates the ref during commit, before any layout effect can call the stable callback
  useInsertionEffect(() => {
    latest.current = fn;
  });
  const [stable] = useState(
    () =>
      (...args: Args) =>
        latest.current(...args),
  );
  return stable;
}
