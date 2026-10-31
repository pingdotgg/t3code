import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

describe("ResetCreditCoordinator", () => {
  it.effect("re-sends the same idempotency key after a failed attempt, then clears it", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make(0);
      const consume = (key: string) =>
        Effect.gen(function* () {
          yield* Ref.update(keys, (seen) => [...seen, key]);
          const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          if (attempt === 1) return yield* Effect.fail("timed out" as const);
          return "reset" as const;
        });

      const first = yield* redeem("acct", consume).pipe(Effect.result);
      assert.isTrue(first._tag === "Failure");
      const second = yield* redeem("acct", consume);
      assert.strictEqual(second, "reset");
      yield* redeem("acct", consume);

      const seen = yield* Ref.get(keys);
      assert.strictEqual(seen.length, 3);
      assert.strictEqual(seen[0], seen[1]);
      assert.notStrictEqual(seen[1], seen[2]);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("starts a fresh attempt after a settled failure", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      const consume = (key: string) =>
        Ref.update(keys, (seen) => [...seen, key]).pipe(
          Effect.andThen(Effect.fail("cooldown" as const)),
        );
      const isSettled = (error: "cooldown") => error === "cooldown";

      yield* redeem("acct", consume, isSettled).pipe(Effect.result);
      yield* redeem("acct", consume, isSettled).pipe(Effect.result);

      const seen = yield* Ref.get(keys);
      assert.strictEqual(seen.length, 2);
      assert.notStrictEqual(seen[0], seen[1]);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("serialises concurrent redemptions on the same account, not per caller", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const release = yield* Deferred.make<void>();
      const inFlight = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const consume = () =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
          yield* Ref.update(peak, (p) => Math.max(p, now));
          yield* Deferred.await(release);
          yield* Ref.update(inFlight, (n) => n - 1);
          return "reset" as const;
        });

      const a = yield* redeem("acct", consume).pipe(Effect.forkChild);
      const b = yield* redeem("acct", consume).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);

      assert.strictEqual(yield* Ref.get(peak), 1);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("keeps different accounts independent", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const release = yield* Deferred.make<void>();
      const peak = yield* Ref.make(0);
      const inFlight = yield* Ref.make(0);
      const consume = () =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
          yield* Ref.update(peak, (p) => Math.max(p, now));
          yield* Deferred.await(release);
          return "reset" as const;
        });
      const a = yield* redeem("acct-a", consume).pipe(Effect.forkChild);
      const b = yield* redeem("acct-b", consume).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      assert.strictEqual(yield* Ref.get(peak), 2);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("runs the fresh exhaustion check under the account lock before consuming once", () =>
    Effect.gen(function* () {
      const { redeemIf } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const exhausted = yield* Ref.make(true);
      const consumes = yield* Ref.make(0);
      const redeem = (key: string) =>
        redeemIf(
          "shared-codex-account",
          key,
          () => Ref.get(exhausted),
          () =>
            Ref.updateAndGet(consumes, (count) => count + 1).pipe(
              Effect.tap(() => Ref.set(exhausted, false)),
              Effect.as("reset" as const),
            ),
        );

      const first = yield* redeem("attempt-a").pipe(Effect.forkChild);
      const second = yield* redeem("attempt-b").pipe(Effect.forkChild);
      const outcomes = [yield* Fiber.join(first), yield* Fiber.join(second)];

      assert.deepEqual(
        outcomes.map((result) => (result._tag === "sent" ? result.outcome : null)).sort(),
        [null, "reset"],
      );
      const sent = outcomes.find((result) => result._tag === "sent");
      assert.isTrue(sent?._tag === "sent");
      if (sent?._tag === "sent") assert.strictEqual(sent.idempotencyKey, "attempt-a");
      assert.strictEqual(yield* Ref.get(consumes), 1);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("does not consume when the fresh check shows the allowance has recovered", () =>
    Effect.gen(function* () {
      const { redeemIf } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const consumes = yield* Ref.make(0);
      const result = yield* redeemIf(
        "account-a",
        "attempt-a",
        () => Effect.succeed(false),
        () => Ref.updateAndGet(consumes, (count) => count + 1).pipe(Effect.as("reset" as const)),
      );

      assert.deepEqual(result, { _tag: "declined" });
      assert.strictEqual(yield* Ref.get(consumes), 0);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("leaves a different account untouched by the matched account's redemption", () =>
    Effect.gen(function* () {
      const { redeemIf } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const consumedAccounts = yield* Ref.make<ReadonlyArray<string>>([]);
      const consume = (account: string) =>
        Ref.update(consumedAccounts, (accounts) => [...accounts, account]).pipe(
          Effect.as("reset" as const),
        );
      for (const account of ["matched-account", "other-account"]) {
        yield* redeemIf(
          account,
          `attempt:${account}`,
          () => Effect.succeed(account === "matched-account"),
          () => consume(account),
        );
      }

      assert.deepEqual(yield* Ref.get(consumedAccounts), ["matched-account"]);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect(
    "serialises manual home-only redemption with automatic home-and-account redemption",
    () =>
      Effect.gen(function* () {
        const { redeem, redeemIf } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const release = yield* Deferred.make<void>();
        const inFlight = yield* Ref.make(0);
        const peak = yield* Ref.make(0);
        const consume = () =>
          Effect.gen(function* () {
            const now = yield* Ref.updateAndGet(inFlight, (value) => value + 1);
            yield* Ref.update(peak, (value) => Math.max(value, now));
            yield* Deferred.await(release);
            yield* Ref.update(inFlight, (value) => value - 1);
            return "reset" as const;
          });
        const manual = yield* redeem(["home:/codex"], consume).pipe(Effect.forkChild);
        const automatic = yield* redeemIf(
          ["home:/codex", "codex-account:fingerprint"],
          "automatic-attempt",
          () => Effect.succeed(true),
          consume,
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(manual);
        const result = yield* Fiber.join(automatic);
        assert.deepEqual(result, {
          _tag: "sent",
          idempotencyKey: "automatic-attempt",
          outcome: "reset",
        });
        assert.strictEqual(yield* Ref.get(peak), 1);
      }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect(
    "does not replace an unresolved manual key when auto redemption gains account identity",
    () =>
      Effect.gen(function* () {
        const { redeemWithKey, redeemIf } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const automaticConsumes = yield* Ref.make(0);
        yield* redeemWithKey(["home:/codex"], "manual-pending-key", () =>
          Effect.fail("lost response" as const),
        ).pipe(Effect.result);
        const result = yield* redeemIf(
          ["home:/codex", "codex-account:fingerprint"],
          "automatic-new-key",
          () => Effect.succeed(true),
          () =>
            Ref.updateAndGet(automaticConsumes, (count) => count + 1).pipe(
              Effect.as("reset" as const),
            ),
        );
        assert.deepEqual(result, { _tag: "conflict", pendingKey: "manual-pending-key" });
        assert.strictEqual(yield* Ref.get(automaticConsumes), 0);
        const secondConflict = yield* redeemIf(
          ["home:/codex", "codex-account:fingerprint"],
          "another-auto-key",
          () => Effect.succeed(true),
          () =>
            Ref.updateAndGet(automaticConsumes, (count) => count + 1).pipe(
              Effect.as("reset" as const),
            ),
        );
        assert.deepEqual(secondConflict, { _tag: "conflict", pendingKey: "manual-pending-key" });
        const manualKeys = yield* Ref.make<ReadonlyArray<string>>([]);
        const manualResult = yield* redeemWithKey(["home:/codex"], "manual-pending-key", () =>
          Ref.updateAndGet(manualKeys, (keys) => [...keys, "manual-pending-key"]).pipe(
            Effect.as("alreadyRedeemed" as const),
          ),
        );
        assert.strictEqual(manualResult, "alreadyRedeemed");
        assert.deepEqual(yield* Ref.get(manualKeys), ["manual-pending-key"]);
        const resumed = yield* redeemIf(
          ["home:/codex", "codex-account:fingerprint"],
          "automatic-new-key",
          () => Effect.succeed(true),
          () =>
            Ref.updateAndGet(automaticConsumes, (count) => count + 1).pipe(
              Effect.as("reset" as const),
            ),
        );
        assert.deepEqual(resumed, {
          _tag: "sent",
          idempotencyKey: "automatic-new-key",
          outcome: "reset",
        });
      }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect(
    "rechecks the armed state after waiting on the account lock and immediately before consume",
    () =>
      Effect.gen(function* () {
        const { redeemIf } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const probeEntered = yield* Deferred.make<void>();
        const finishProbe = yield* Deferred.make<void>();
        const stopped = yield* Ref.make(false);
        const consumes = yield* Ref.make(0);
        const attempt = yield* redeemIf(
          ["home:/codex", "codex-account:fingerprint"],
          "attempt-after-stop-check",
          () =>
            Deferred.succeed(probeEntered, undefined).pipe(
              Effect.andThen(Deferred.await(finishProbe)),
              Effect.andThen(Ref.get(stopped)),
              Effect.map((isStopped) => !isStopped),
            ),
          () => Ref.updateAndGet(consumes, (count) => count + 1).pipe(Effect.as("reset" as const)),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(probeEntered);
        yield* Ref.set(stopped, true);
        yield* Deferred.succeed(finishProbe, undefined);
        assert.deepEqual(yield* Fiber.join(attempt), { _tag: "declined" });
        assert.strictEqual(yield* Ref.get(consumes), 0);
      }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );
});
