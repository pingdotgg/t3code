import * as Effect from "effect/Effect";

const listeners = new Set<(exitCode: number) => void>();

/** Process-local handoff channel. The CLI races this against the scoped server runtime. */
export const request = (exitCode: number): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const listener of listeners) listener(exitCode);
  });

export const awaitRequest: Effect.Effect<number> = Effect.callback((resume) => {
  const listener = (exitCode: number) => resume(Effect.succeed(exitCode));
  listeners.add(listener);
  return Effect.sync(() => listeners.delete(listener));
});
