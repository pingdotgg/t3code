/**
 * Redeeming a reset credit is an account-level action: instances that share
 * the directory holding a provider's login share the credit, so their
 * redemptions must serialise on that directory, not the instance. This
 * service keeps one lock and one pending idempotency key per account key so
 * overlapping confirmations from any instance queue rather than spending two
 * credits, and a retry after a timeout re-sends the same attempt.
 *
 * @module provider/Layers/resetCreditCoordinator
 */
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
    /**
     * Run `consume` under the account's lock with a stable idempotency key.
     * The key is cleared when the provider reports an outcome, or when
     * `isSettled` says a failure was a final answer (such as a cooldown).
     * Any other failure (timeout included) keeps it so the next attempt is
     * the same attempt.
     */
    readonly redeem: <E, R>(
      accountKey: string,
      consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled?: (error: E) => boolean,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E | PlatformError.PlatformError, R>;
  }
>()("t3/provider/Layers/resetCreditCoordinator") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const statesRef = yield* Ref.make<ReadonlyMap<string, AccountRedemptionState>>(new Map());

  // Get-or-create through one Ref.modify so two first redemptions for the
  // same account cannot each install their own lock.
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

  const redeem: ResetCreditCoordinator["Service"]["redeem"] = (accountKey, consume, isSettled) =>
    Effect.gen(function* () {
      const state = yield* stateFor(accountKey);
      return yield* state.lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* Ref.get(state.pendingKey);
          const idempotencyKey = existing ?? (yield* crypto.randomUUIDv4);
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

/**
 * Self-contained for tests: a counter-backed Crypto so keys are deterministic
 * and distinct without the platform layer.
 */
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
