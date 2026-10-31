/** Instances sharing a login directory share credits; serialize redemptions on that directory. */
import type { ProviderConsumeResetCreditOutcome } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

interface AccountRedemptionState {
  readonly lock: Semaphore.Semaphore;
  readonly pendingKey: Ref.Ref<string | null>;
}

export class ResetCreditCoordinator extends Context.Service<
  ResetCreditCoordinator,
  {
    /** Reuse the idempotency key until an outcome or settled failure; timeouts keep it for retry. */
    readonly redeem: <E, R>(
      accountKey: string,
      consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled?: (error: E) => boolean,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E | PlatformError.PlatformError, R>;
  }
>()("t3/provider/resetCreditCoordinator") {}

/** @public */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const statesRef = yield* Ref.make<ReadonlyMap<string, AccountRedemptionState>>(new Map());

  // Create account locks atomically so concurrent first redemptions cannot use separate locks.
  const stateFor = Effect.fn("ResetCreditCoordinator.stateFor")(function* (accountKey: string) {
    const existing = (yield* Ref.get(statesRef)).get(accountKey);
    if (existing) return existing;
    const candidate = {
      lock: yield* Semaphore.make(1),
      pendingKey: yield* Ref.make<string | null>(null),
    };
    return yield* Ref.modify(statesRef, (states) => {
      const current = states.get(accountKey);
      if (current) return [current, states] as const;
      const next = new Map(states);
      next.set(accountKey, candidate);
      return [candidate, next] as const;
    });
  });

  const redeem: ResetCreditCoordinator["Service"]["redeem"] = Effect.fn(
    "resetCreditCoordinator.redeem",
  )(function* (accountKey, consume, isSettled) {
    const state = yield* stateFor(accountKey);
    return yield* state.lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* Ref.get(state.pendingKey);
        const idempotencyKey = existing ?? (yield* crypto.randomUUIDv4());
        yield* Ref.set(state.pendingKey, idempotencyKey);
        const outcome = yield* consume(idempotencyKey).pipe(
          Effect.tapError((error) =>
            isSettled?.(error) ? Ref.set(state.pendingKey, null) : Effect.void,
          ),
        );
        yield* Ref.set(state.pendingKey, null);
        return outcome;
      }),
    );
  });

  return { redeem } satisfies ResetCreditCoordinator["Service"];
});

export const layer = Layer.effect(ResetCreditCoordinator, make);

export const layerTest = Layer.effect(
  ResetCreditCoordinator,
  Effect.gen(function* () {
    let counter = 0;
    return yield* make.pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => {
            counter += 1;
            return new Uint8Array(size).fill(counter);
          },
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    );
  }),
);
