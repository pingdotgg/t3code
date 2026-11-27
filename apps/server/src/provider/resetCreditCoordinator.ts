/** Instances sharing a login directory share credits; serialize redemptions and share reads on it. */
import type { ProviderConsumeResetCreditOutcome, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

// Instances refresh within moments of each other, each after its own CLI probe; one read serves them.
const SHARED_READ_WINDOW_MS = 10_000;

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
    /** Reads for one account within a short window share one result; a redemption drops it. */
    readonly shareRead: <A, E>(
      accountKey: string,
      read: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E>;
  }
>()("t3/provider/resetCreditCoordinator") {}

/** @public */
export const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const statesRef = yield* Ref.make<ReadonlyMap<string, AccountRedemptionState>>(new Map());
  const scope = yield* Effect.scope;
  const readsLock = yield* Semaphore.make(1);
  const readsRef = yield* Ref.make<
    ReadonlyMap<
      string,
      { readonly fiber: Fiber.Fiber<unknown, unknown>; readonly startedAt: number }
    >
  >(new Map());

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

  const forgetRead = (accountKey: string) =>
    readsLock.withPermits(1)(
      Ref.update(readsRef, (reads) => {
        const next = new Map(reads);
        next.delete(accountKey);
        return next;
      }),
    );

  const redeem: ResetCreditCoordinator["Service"]["redeem"] = Effect.fn(
    "resetCreditCoordinator.redeem",
  )(function* (accountKey, consume, isSettled) {
    const state = yield* stateFor(accountKey);
    return yield* state.lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* Ref.get(state.pendingKey);
        const idempotencyKey = existing ?? (yield* random.uuidV4());
        yield* Ref.set(state.pendingKey, idempotencyKey);
        const outcome = yield* consume(idempotencyKey).pipe(
          Effect.tapError((error) =>
            isSettled?.(error) ? Ref.set(state.pendingKey, null) : Effect.void,
          ),
          Effect.ensuring(forgetRead(accountKey)),
        );
        yield* Ref.set(state.pendingKey, null);
        return outcome;
      }),
    );
  });

  const shareRead: ResetCreditCoordinator["Service"]["shareRead"] = Effect.fn(
    "resetCreditCoordinator.shareRead",
  )(function* <A, E>(accountKey: string, read: Effect.Effect<A, E>) {
    const fiber = yield* readsLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const shared = (yield* Ref.get(readsRef)).get(accountKey);
          if (shared && now - shared.startedAt < SHARED_READ_WINDOW_MS) {
            return shared.fiber as Fiber.Fiber<A, E>;
          }
          // Forked into the coordinator's scope so one caller's interruption never cancels the others.
          const fiber = yield* Effect.forkIn(read, scope);
          yield* Ref.update(readsRef, (reads) =>
            new Map(reads).set(accountKey, { fiber, startedAt: now }),
          );
          return fiber;
        }),
      ),
    );
    return yield* Fiber.join(fiber);
  });

  return { redeem, shareRead } satisfies ResetCreditCoordinator["Service"];
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
