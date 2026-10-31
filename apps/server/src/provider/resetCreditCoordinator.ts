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
      accountKey: string | ReadonlyArray<string>,
      consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled?: (error: E) => boolean,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E | PlatformError.PlatformError, R>;
    readonly redeemWithKey: <E, R>(
      accountKey: string | ReadonlyArray<string>,
      idempotencyKey: string,
      consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled?: (error: E) => boolean,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E | PlatformError.PlatformError, R>;
    readonly redeemIf: <A, E, R>(
      accountKey: string | ReadonlyArray<string>,
      idempotencyKey: string,
      shouldRedeem: () => Effect.Effect<boolean, E, R>,
      consume: (idempotencyKey: string) => Effect.Effect<A, E, R>,
      isSettled?: (error: E) => boolean,
    ) => Effect.Effect<
      | { readonly _tag: "declined" }
      | { readonly _tag: "conflict"; readonly pendingKey: string }
      | {
          readonly _tag: "sent";
          readonly idempotencyKey: string;
          readonly outcome: A;
        },
      E | PlatformError.PlatformError,
      R
    >;
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

  const withAccountLocks = <A, E, R>(
    requested: string | ReadonlyArray<string>,
    run: () => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PlatformError.PlatformError, R> => {
    const keys = Array.from(
      new Set(typeof requested === "string" ? [requested] : requested),
    ).sort();
    const lockAt = (index: number): Effect.Effect<A, E | PlatformError.PlatformError, R> =>
      index >= keys.length
        ? run()
        : Effect.gen(function* () {
            const state = yield* stateFor(keys[index]!);
            return yield* state.lock.withPermits(1)(lockAt(index + 1));
          });
    return lockAt(0);
  };

  const accountStates = (requested: string | ReadonlyArray<string>) => {
    const keys = Array.from(
      new Set(typeof requested === "string" ? [requested] : requested),
    ).sort();
    return Effect.forEach(keys, stateFor);
  };
  const setPendingKey = (states: ReadonlyArray<AccountRedemptionState>, key: string | null) =>
    Effect.forEach(states, (state) => Ref.set(state.pendingKey, key), { discard: true });
  const clearPendingKey = (states: ReadonlyArray<AccountRedemptionState>, key: string) =>
    Effect.forEach(
      states,
      (state) => Ref.update(state.pendingKey, (current) => (current === key ? null : current)),
      { discard: true },
    );

  const redeemWithKey: ResetCreditCoordinator["Service"]["redeemWithKey"] = Effect.fn(
    "resetCreditCoordinator.redeemWithKey",
  )(function* (accountKey, requestedKey, consume, isSettled) {
    return yield* withAccountLocks(accountKey, () =>
      Effect.gen(function* () {
        const states = yield* accountStates(accountKey);
        const pendingKeys = yield* Effect.forEach(states, (state) => Ref.get(state.pendingKey));
        const existing = pendingKeys.find((key) => key !== null) ?? null;
        const idempotencyKey = existing ?? requestedKey;
        yield* setPendingKey(states, idempotencyKey);
        const outcome = yield* consume(idempotencyKey).pipe(
          Effect.tapError((error) =>
            isSettled?.(error) ? setPendingKey(states, null) : Effect.void,
          ),
        );
        yield* setPendingKey(states, null);
        return outcome;
      }),
    );
  });

  const redeemIf: ResetCreditCoordinator["Service"]["redeemIf"] = Effect.fn(
    "resetCreditCoordinator.redeemIf",
  )(function* (accountKey, requestedKey, shouldRedeem, consume, isSettled) {
    return yield* withAccountLocks(accountKey, () =>
      Effect.gen(function* () {
        const states = yield* accountStates(accountKey);
        const pendingKeys = yield* Effect.forEach(states, (state) => Ref.get(state.pendingKey));
        const existingKeys = pendingKeys.filter((key): key is string => key !== null);
        const conflict = existingKeys.find((key) => key !== requestedKey);
        if (conflict !== undefined) return { _tag: "conflict" as const, pendingKey: conflict };
        if (!(yield* shouldRedeem())) return { _tag: "declined" as const };
        yield* setPendingKey(states, requestedKey);
        return yield* Effect.gen(function* () {
          const outcome = yield* consume(requestedKey).pipe(
            Effect.tapError((error) =>
              isSettled?.(error) ? clearPendingKey(states, requestedKey) : Effect.void,
            ),
          );
          return { _tag: "sent" as const, idempotencyKey: requestedKey, outcome };
        }).pipe(Effect.ensuring(clearPendingKey(states, requestedKey)));
      }),
    );
  });

  const redeem: ResetCreditCoordinator["Service"]["redeem"] = Effect.fn(
    "ResetCreditCoordinator.redeem",
  )(function* (accountKey, consume, isSettled) {
    const key = yield* crypto.randomUUIDv4();
    return yield* redeemWithKey(accountKey, key, consume, isSettled);
  });

  return { redeem, redeemWithKey, redeemIf } satisfies ResetCreditCoordinator["Service"];
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
