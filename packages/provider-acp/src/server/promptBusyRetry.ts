import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

export interface AcpPromptBusyRetryPolicy {
  readonly maxAttempts: number;
  readonly isBusyFailure: (cause: Cause.Cause<unknown>) => boolean;
  readonly delayMs: (attempt: number) => number;
}

export interface AcpPromptBusyRetryGuard {
  readonly cancelled: Effect.Effect<boolean>;
}

export const makeAcpPromptBusyRetryGate = Effect.fn("AcpPromptBusyRetryGate.make")(function* () {
  const cancelledRef = yield* Ref.make(false);
  return {
    issue: Ref.set(cancelledRef, false),
    cancel: Ref.set(cancelledRef, true),
    cancelled: Ref.get(cancelledRef),
  };
});

export function retryPromptOnBusy<A, E, R>(
  policy: AcpPromptBusyRetryPolicy | undefined,
  effect: Effect.Effect<A, E, R>,
  guard?: AcpPromptBusyRetryGuard,
): Effect.Effect<A, E, R> {
  if (policy === undefined) return effect;
  const run = (attempt: number): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.catchCause((cause) => {
        // An interrupt is a user action and never a busy rejection.
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        if (attempt >= policy.maxAttempts || !policy.isBusyFailure(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.sleep(Duration.millis(policy.delayMs(attempt))).pipe(
          Effect.andThen(guard === undefined ? Effect.succeed(false) : guard.cancelled),
          Effect.flatMap((cancelled) =>
            cancelled ? Effect.failCause(Cause.interrupt()) : run(attempt + 1),
          ),
        );
      }),
    );
  return run(1);
}
