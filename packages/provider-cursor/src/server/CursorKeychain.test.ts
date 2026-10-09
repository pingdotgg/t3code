import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as CursorKeychain from "./CursorKeychain.ts";

describe("CursorKeychain", () => {
  it.effect("shares concurrent reads and rechecks after the cache expires", () =>
    Effect.gen(function* () {
      let reads = 0;
      const keychain = CursorKeychain.make(
        Effect.sync(() => {
          reads++;
          return `token-${reads}`;
        }),
      );
      assert.deepStrictEqual(
        yield* Effect.all([keychain.accessToken, keychain.accessToken], {
          concurrency: "unbounded",
        }),
        ["token-1", "token-1"],
      );
      assert.strictEqual(yield* keychain.accessToken, "token-1");
      assert.strictEqual(reads, 1);
      yield* TestClock.adjust(Duration.minutes(5));
      assert.strictEqual(yield* keychain.accessToken, "token-2");
    }),
  );

  it.effect("gives up on an unanswered prompt and reuses it on the next read", () =>
    Effect.gen(function* () {
      let reads = 0;
      const allow = yield* Deferred.make<string>();
      const keychain = CursorKeychain.make(
        Effect.suspend(() => {
          reads++;
          return Deferred.await(allow);
        }),
        Duration.millis(1),
      );
      const timedOut = yield* keychain.accessToken.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(1));
      const error = yield* Fiber.join(timedOut).pipe(Effect.flip);
      assert.isTrue(CursorKeychain.isCursorKeychainTimeoutError(error));
      const retry = yield* keychain.accessToken.pipe(Effect.forkChild);
      yield* Deferred.succeed(allow, "token");
      assert.strictEqual(yield* Fiber.join(retry), "token");
      assert.strictEqual(reads, 1);
    }),
  );
});
