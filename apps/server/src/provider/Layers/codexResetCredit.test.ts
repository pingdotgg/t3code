import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { CodexResetCreditCoordinator, layerTest } from "./codexResetCredit.ts";

describe("CodexResetCreditCoordinator", () => {
  it.effect("re-sends the same idempotency key after a failed attempt, then clears it", () =>
    Effect.gen(function* () {
      const { redeem } = yield* CodexResetCreditCoordinator;
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
      // A fresh redemption after success must be a fresh attempt.
      yield* redeem("acct", consume);

      const seen = yield* Ref.get(keys);
      assert.strictEqual(seen.length, 3);
      assert.strictEqual(seen[0], seen[1]);
      assert.notStrictEqual(seen[1], seen[2]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serialises concurrent redemptions on the same account, not per caller", () =>
    Effect.gen(function* () {
      const { redeem } = yield* CodexResetCreditCoordinator;
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

      // Two instances of the same account redeem at once.
      const a = yield* redeem("acct", consume).pipe(Effect.forkChild);
      const b = yield* redeem("acct", consume).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);

      assert.strictEqual(yield* Ref.get(peak), 1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps different accounts independent", () =>
    Effect.gen(function* () {
      const { redeem } = yield* CodexResetCreditCoordinator;
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
    }).pipe(Effect.provide(layerTest)),
  );
});
