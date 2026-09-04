/**
 * Redeeming a Codex reset credit is an account-level action: two instances
 * pointed at the same Codex home share the credit, so their redemptions must
 * serialise on the account, not the instance. This keeps one lock and one
 * pending idempotency key per account key (the driver's continuation key),
 * so overlapping confirmations from any instance queue rather than spending
 * two credits, and a retry after a timeout re-sends the same attempt.
 *
 * @module provider/Layers/codexResetCredit
 */
import type { ProviderConsumeResetCreditOutcome } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

/**
 * Bounded so a hung app-server cannot hold the account lock forever; the
 * timeout interrupts the scoped request, which kills the process, and the
 * kept idempotency key makes the user's retry safe.
 */
export const CODEX_RESET_CREDIT_TIMEOUT = Duration.seconds(20);

interface AccountRedemptionState {
  readonly lock: Semaphore.Semaphore;
  readonly pendingKey: Ref.Ref<string | null>;
}

const accountStates = new Map<string, AccountRedemptionState>();

const stateForAccount = (accountKey: string): Effect.Effect<AccountRedemptionState> =>
  Effect.gen(function* () {
    const existing = accountStates.get(accountKey);
    if (existing) return existing;
    const created = {
      lock: yield* Semaphore.make(1),
      pendingKey: yield* Ref.make<string | null>(null),
    };
    accountStates.set(accountKey, created);
    return created;
  });

/**
 * Run `consume` under the account's lock with a stable idempotency key.
 * The key is cleared only when Codex reports an outcome; a failure (timeout
 * included) keeps it so the next attempt is the same attempt.
 */
export const redeemCodexResetCredit = <E, R>(
  accountKey: string,
  consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
): Effect.Effect<
  ProviderConsumeResetCreditOutcome,
  E | PlatformError.PlatformError,
  R | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const state = yield* stateForAccount(accountKey);
    const crypto = yield* Crypto.Crypto;
    return yield* state.lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* Ref.get(state.pendingKey);
        const idempotencyKey = existing ?? (yield* crypto.randomUUIDv4);
        yield* Ref.set(state.pendingKey, idempotencyKey);
        const outcome = yield* consume(idempotencyKey);
        yield* Ref.set(state.pendingKey, null);
        return outcome;
      }),
    );
  });

/** Test hook: forget every account's lock and pending key. */
export const resetCodexRedemptionStateForTests = (): void => {
  accountStates.clear();
};
