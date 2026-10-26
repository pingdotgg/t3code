import { useInsertionEffect, useRef, useState } from "react";

/** Call only from handlers and effects; render sees the previous commit's fn. */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);
  // Insertion effects run before every layout effect in the commit, so a
  // child's layout effect already calls this render's fn.
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
