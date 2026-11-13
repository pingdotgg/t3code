/** Instances sharing a login directory share credits; serialize redemptions on that directory. */
import type { ProviderConsumeResetCreditOutcome, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

interface AccountRedemptionState {
  readonly lock: Semaphore.Semaphore;
  readonly pendingKeys: Ref.Ref<ReadonlyMap<string, string>>;
}

export class ResetCreditCoordinator extends Context.Service<
  ResetCreditCoordinator,
  {
    /**
     * Reuse the idempotency key until an outcome or settled failure; timeouts keep it for retry.
     * `credit` names what is redeemed when an account holds several, so each keeps its own key.
     */
    readonly redeem: <E, R>(
      accountKey: string,
      consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled?: (error: E) => boolean,
      credit?: string,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E | PlatformError.PlatformError, R>;
  }
>()("t3/provider/resetCreditCoordinator") {}

/** @public */
export const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const statesRef = yield* Ref.make<ReadonlyMap<string, AccountRedemptionState>>(new Map());

  // Create account locks atomically so concurrent first redemptions cannot use separate locks.
  const stateFor = Effect.fn("ResetCreditCoordinator.stateFor")(function* (accountKey: string) {
    const existing = (yield* Ref.get(statesRef)).get(accountKey);
    if (existing) return existing;
    const candidate = {
      lock: yield* Semaphore.make(1),
      pendingKeys: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
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
  )(function* (accountKey, consume, isSettled, credit = "") {
    const state = yield* stateFor(accountKey);
    const settle = Ref.update(state.pendingKeys, (pending) => {
      const next = new Map(pending);
      next.delete(credit);
      return next;
    });
    return yield* state.lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = (yield* Ref.get(state.pendingKeys)).get(credit);
        const idempotencyKey = existing ?? (yield* random.uuidV4());
        yield* Ref.update(state.pendingKeys, (pending) =>
          new Map(pending).set(credit, idempotencyKey),
        );
        const outcome = yield* consume(idempotencyKey).pipe(
          Effect.tapError((error) => (isSettled?.(error) ? settle : Effect.void)),
        );
        yield* settle;
        return outcome;
      }),
    );
  });

  return { redeem } satisfies ResetCreditCoordinator["Service"];
});

type UsageSnapshot = Pick<ServerProvider, "usageLimits">;

/**
 * Re-probe after a redemption; true once a `reset` shows fresh limits. A failed
 * usage read republishes the pre-redemption windows, which are known stale after
 * a reset, so retry briefly instead of leaving them until the periodic check.
 */
export const refreshAfterRedemption = Effect.fn("resetCreditCoordinator.refreshAfterRedemption")(
  function* <R>(input: {
    readonly outcome: ProviderConsumeResetCreditOutcome;
    readonly getSnapshot: Effect.Effect<UsageSnapshot>;
    readonly refresh: Effect.Effect<UsageSnapshot, never, R>;
  }) {
    const before = (yield* input.getSnapshot).usageLimits?.checkedAt;
    const confirmed = ({ usageLimits }: UsageSnapshot) =>
      input.outcome !== "reset" ||
      (usageLimits !== undefined &&
        usageLimits.checkedAt !== before &&
        usageLimits.unavailable?.reason !== "probeFailed");
    return yield* input.refresh.pipe(
      Effect.map(confirmed),
      Effect.repeat({
        until: (ok) => ok,
        times: 3,
        schedule: Schedule.exponential("1 second"),
      }),
    );
  },
);

export const layer = Layer.effect(ResetCreditCoordinator, make);

export const layerTest = Layer.effect(
  ResetCreditCoordinator,
  Effect.gen(function* () {
    let counter = 0;
    return yield* make.pipe(
      Effect.provideService(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => {
          counter += 1;
          return new Uint8Array(size).fill(counter);
        }),
      ),
    );
  }),
);
