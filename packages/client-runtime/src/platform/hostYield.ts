import * as Effect from "effect/Effect";

// Effect's own yield resumes through `setImmediate` where the host defines it and a
// zero-delay timer otherwise. React Native's `setImmediate` is a microtask shim, so
// nothing from the host runs before the fiber resumes. A timer yields on every host;
// a browser can pass a yield that its timer clamping and throttling do not slow.
export const yieldToHostTimer = Effect.callback<void>((resume) => {
  // @effect-diagnostics-next-line globalTimersInEffect:off - A host timer, not Effect.sleep, is the point.
  const timer = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(timer));
});
