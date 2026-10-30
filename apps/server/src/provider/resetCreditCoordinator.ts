import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  claudeResetCreditsToContract,
  type ClaudeResetCreditReadError,
} from "./claudeResetCredits.ts";

interface ClaudeReadState {
  readonly nextAttemptAt: number;
  readonly interval: number;
  readonly block: unknown;
}

const READ_INTERVAL = 10 * 60_000;
const MAX_READ_INTERVAL = 60 * 60_000;
const EMPTY_CLAUDE_READ: ClaudeReadState = {
  nextAttemptAt: 0,
  interval: READ_INTERVAL,
  block: undefined,
};

interface AccountRedemptionState {
  readonly lock: Semaphore.Semaphore;
  readonly pendingKey: Ref.Ref<string | null>;
  readonly claudeRead: Ref.Ref<ClaudeReadState>;
  readonly pendingClaudeGrant: Ref.Ref<string | null>;
}

export class ResetCreditCoordinator extends Context.Service<
  ResetCreditCoordinator,
  {
    readonly readClaudeCredits: <R>(
      accountKey: string,
      read: Effect.Effect<Option.Option<unknown>, ClaudeResetCreditReadError, R>,
    ) => Effect.Effect<ServerProviderResetCredits | undefined, never, R>;
    readonly redeemClaudeCredit: <E, R>(
      accountKey: string,
      consume: (
        grantId: string,
        idempotencyKey: string,
      ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled: (error: E) => boolean,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E | PlatformError.PlatformError, R>;
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

  // Get-or-create through one Ref.modify so two first redemptions for the
  // same account cannot each install their own lock.
  const stateFor = Effect.fn("ResetCreditCoordinator.stateFor")(function* (accountKey: string) {
    const existing = (yield* Ref.get(statesRef)).get(accountKey);
    if (existing) return existing;
    const candidate = {
      lock: yield* Semaphore.make(1),
      pendingKey: yield* Ref.make<string | null>(null),
      claudeRead: yield* Ref.make(EMPTY_CLAUDE_READ),
      pendingClaudeGrant: yield* Ref.make<string | null>(null),
    };
    return yield* Ref.modify(statesRef, (states) => {
      const current = states.get(accountKey);
      if (current) return [current, states] as const;
      const next = new Map(states);
      next.set(accountKey, candidate);
      return [candidate, next] as const;
    });
  });

  const redeemLocked = Effect.fn("ResetCreditCoordinator.redeemLocked")(function* <E, R>(
    state: AccountRedemptionState,
    consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
    isSettled?: (error: E) => boolean,
  ) {
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
  });

  const redeem: ResetCreditCoordinator["Service"]["redeem"] = Effect.fn(
    "resetCreditCoordinator.redeem",
  )(function* (accountKey, consume, isSettled) {
    const state = yield* stateFor(accountKey);
    return yield* state.lock.withPermits(1)(redeemLocked(state, consume, isSettled));
  });

  const readClaudeCredits: ResetCreditCoordinator["Service"]["readClaudeCredits"] = Effect.fn(
    "ResetCreditCoordinator.readClaudeCredits",
  )(function* (accountKey, read) {
    const state = yield* stateFor(accountKey);
    return yield* state.lock.withPermits(1)(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const known = yield* Ref.get(state.claudeRead);
          const now = yield* Clock.currentTimeMillis;
          if (now < known.nextAttemptAt) return claudeResetCreditsToContract(known.block, now);
          // Cancellation after dispatch still spends the account's regular read budget.
          yield* Ref.set(state.claudeRead, { ...known, nextAttemptAt: now + READ_INTERVAL });
          const result = yield* Effect.result(restore(read));
          if (result._tag === "Success" && Option.isNone(result.success)) {
            yield* Ref.set(state.claudeRead, known);
            return claudeResetCreditsToContract(known.block, yield* Clock.currentTimeMillis);
          }
          const interval =
            result._tag === "Success"
              ? READ_INTERVAL
              : Math.min(known.interval * 2, MAX_READ_INTERVAL);
          const block =
            result._tag === "Success" ? Option.getOrUndefined(result.success) : known.block;
          yield* Ref.set(state.claudeRead, { nextAttemptAt: now + interval, interval, block });
          return claudeResetCreditsToContract(block, yield* Clock.currentTimeMillis);
        }),
      ),
    );
  });

  const redeemClaudeCredit: ResetCreditCoordinator["Service"]["redeemClaudeCredit"] = Effect.fn(
    "ResetCreditCoordinator.redeemClaudeCredit",
  )(function* (accountKey, consume, isSettled) {
    const state = yield* stateFor(accountKey);
    return yield* state.lock.withPermits(1)(
      // Record confirmed outcomes before cancellation can restore the pre-claim answer.
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const known = yield* Ref.get(state.claudeRead);
          const grantId =
            (yield* Ref.get(state.pendingClaudeGrant)) ??
            claudeResetCreditsToContract(known.block, yield* Clock.currentTimeMillis)?.nextCreditId;
          if (!grantId) return "noCredit" as const;
          yield* Ref.set(state.pendingClaudeGrant, grantId);
          yield* Ref.set(state.claudeRead, EMPTY_CLAUDE_READ);
          return yield* redeemLocked(
            state,
            (requestId) =>
              restore(consume(grantId, requestId)).pipe(
                Effect.tapError((error) =>
                  isSettled(error) ? Ref.set(state.claudeRead, known) : Effect.void,
                ),
              ),
            isSettled,
          ).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                if ((yield* Ref.get(state.pendingKey)) === null)
                  yield* Ref.set(state.pendingClaudeGrant, null);
                else yield* Ref.set(state.claudeRead, { ...known, nextAttemptAt: 0 });
              }),
            ),
          );
        }),
      ),
    );
  });

  return {
    redeem,
    readClaudeCredits,
    redeemClaudeCredit,
  } satisfies ResetCreditCoordinator["Service"];
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
