import type { ProviderInstallState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";

export function isProviderInstallActive(state: ProviderInstallState) {
  return (
    state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying"
  );
}

/** Downloads belong to the environment scope, so disconnecting a client cannot cancel them. */
export const makeProviderInstallOperation = Effect.fn("makeProviderInstallOperation")(function* (
  state: SubscriptionRef.SubscriptionRef<ProviderInstallState>,
) {
  const scope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  let running: { operationId: string; fiber: Fiber.Fiber<void> } | undefined;
  const start = Effect.fn("ProviderInstallOperation.start")(function* <E>(
    work: Effect.Effect<void, E>,
    message: string,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (isProviderInstallActive(current)) return current;
    const operationId = yield* crypto.randomUUIDv4;
    const next: ProviderInstallState = {
      ...current,
      operationId,
      phase: "downloading",
      downloadedBytes: 0,
      message,
    };
    yield* SubscriptionRef.set(state, next);
    const fiber = yield* Effect.forkIn(
      Effect.interruptible(work).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? SubscriptionRef.update(state, (value) => {
                if (value.operationId !== operationId || value.phase === "succeeded") return value;
                const cancelled = Cause.hasInterruptsOnly(exit.cause);
                const error = Cause.squash(exit.cause);
                return {
                  ...value,
                  phase: cancelled ? "cancelled" : "failed",
                  message: cancelled
                    ? "Installation cancelled."
                    : error instanceof Error
                      ? error.message
                      : "Installation failed. Try again.",
                } satisfies ProviderInstallState;
              })
            : Effect.void,
        ),
        Effect.ignoreCause,
        Effect.ensuring(
          Effect.sync(() => {
            if (running?.operationId === operationId) running = undefined;
          }),
        ),
      ),
      scope,
    );
    running = { operationId, fiber };
    return next;
  }, Effect.uninterruptible);
  const cancel = Effect.fn("ProviderInstallOperation.cancel")(function* (operationId: string) {
    const current = yield* SubscriptionRef.get(state);
    if (running?.operationId === operationId && isProviderInstallActive(current))
      yield* Fiber.interrupt(running.fiber);
    return yield* SubscriptionRef.get(state);
  });
  return { start, cancel };
});
