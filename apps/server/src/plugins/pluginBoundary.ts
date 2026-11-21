// @effect-diagnostics anyUnknownInErrorContext:off - External plugin errors are decoded at this boundary into PluginError.
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { PluginError } from "@t3tools/contracts";

export type ExternalPluginEffect = Effect.Effect<unknown, unknown>;

/** The plugin protocol prohibits uncaptured service requirements. */
export const isExternalPluginEffect = (value: unknown): value is ExternalPluginEffect =>
  Effect.isEffect(value);

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const executePlugin = (run: () => unknown): Effect.Effect<unknown, PluginError> =>
  Effect.try({ try: run, catch: (cause) => new PluginError({ message: message(cause) }) }).pipe(
    Effect.flatMap((result) =>
      isExternalPluginEffect(result)
        ? result.pipe(
            Effect.catchCause((cause) =>
              Effect.fail(new PluginError({ message: Cause.pretty(cause) })),
            ),
          )
        : result instanceof Promise
          ? Effect.tryPromise({
              try: () => result,
              catch: (cause) => new PluginError({ message: message(cause) }),
            })
          : Effect.succeed(result),
    ),
  );

/** Preserve the original typed failure and never replay a thunk after it was called. */
export const runBuiltinPluginWrappers = Effect.fn("runBuiltinPluginWrappers")(function* <A, E>(
  wrappers: ReadonlyArray<(input: unknown, next: () => ExternalPluginEffect) => unknown>,
  input: unknown,
  original: Effect.Effect<A, E>,
  log: (cause: Cause.Cause<unknown>) => Effect.Effect<void>,
): Effect.fn.Return<A, E> {
  if (wrappers.length === 0) return yield* original;
  let nextInvoked = false;
  let nextFailure: Cause.Cause<E> | undefined;
  const once = yield* Effect.cached(
    original.pipe(
      Effect.onError((cause) =>
        Effect.sync(() => {
          nextFailure = cause;
        }),
      ),
    ),
  );
  let wrapped: ExternalPluginEffect = Effect.suspend(() => {
    nextInvoked = true;
    return once;
  });
  for (const wrap of wrappers) {
    const previous = yield* Effect.cached(wrapped);
    wrapped = executePlugin(() => wrap(input, () => previous));
  }
  return yield* wrapped.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* log(cause);
        if (nextFailure) return yield* Effect.failCause(nextFailure);
        if (nextInvoked) return yield* Effect.die(new Error(Cause.pretty(cause)));
        return yield* original;
      }),
    ),
    // The transport validates the existing RPC success schema before delivering it.
    Effect.map((output) => output as A),
  );
});
