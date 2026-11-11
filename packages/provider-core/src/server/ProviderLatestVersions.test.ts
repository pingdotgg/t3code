import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

describe("ProviderLatestVersions", () => {
  it.effect("concurrent misses for one key share a single lookup", () =>
    Effect.gen(function* () {
      const latestVersions = yield* ProviderLatestVersions.make();
      const release = yield* Deferred.make<void>();
      let lookups = 0;
      const lookup = Effect.suspend(() => {
        lookups += 1;
        return Deferred.await(release).pipe(Effect.as("2.0.0"));
      });

      const callers = yield* Effect.forEach([1, 2, 3], () =>
        Effect.forkChild(latestVersions.cached("@example/cli", lookup), {
          startImmediately: true,
        }),
      );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Effect.forEach(callers, Fiber.join)).toEqual(["2.0.0", "2.0.0", "2.0.0"]);
      expect(lookups).toBe(1);
    }),
  );

  it.effect("a waiting caller looks up again when the shared lookup is interrupted", () =>
    Effect.gen(function* () {
      const latestVersions = yield* ProviderLatestVersions.make();
      let lookups = 0;
      const lookup = Effect.suspend(() => {
        lookups += 1;
        return lookups === 1 ? Effect.never : Effect.succeed("2.0.0");
      });

      const owner = yield* Effect.forkChild(latestVersions.cached("@example/cli", lookup), {
        startImmediately: true,
      });
      const waiter = yield* Effect.forkChild(latestVersions.cached("@example/cli", lookup), {
        startImmediately: true,
      });
      expect(lookups).toBe(1);
      yield* Fiber.interrupt(owner);
      expect(yield* Fiber.join(waiter)).toBe("2.0.0");
      expect(yield* latestVersions.cached("@example/cli", lookup)).toBe("2.0.0");
      expect(lookups).toBe(2);
    }),
  );

  it.effect("a caller interrupted while it claims the lookup frees the key", () =>
    Effect.gen(function* () {
      const latestVersions = yield* ProviderLatestVersions.make();
      let lookups = 0;
      const lookup = Effect.sync(() => {
        lookups += 1;
        return "2.0.0";
      });
      // `cached` reads `fresh` in the same step that claims the key, so the
      // interrupt arrives after the claim and before the lookup starts.
      const interruptOnClaim = {
        get fresh() {
          Fiber.getCurrent()?.interruptUnsafe();
          return false;
        },
      };

      const owner = yield* Effect.forkChild(
        latestVersions.cached("@example/cli", lookup, interruptOnClaim),
        { startImmediately: true },
      );
      expect(Exit.hasInterrupts(yield* Fiber.await(owner))).toBe(true);
      expect(lookups).toBe(0);
      const next = yield* Effect.forkChild(latestVersions.cached("@example/cli", lookup), {
        startImmediately: true,
      });
      expect(lookups).toBe(1);
      expect(yield* Fiber.join(next)).toBe("2.0.0");
    }),
  );
  it.effect("a waiting caller retries with its own lookup after the owner fails", () =>
    Effect.gen(function* () {
      const latestVersions = yield* ProviderLatestVersions.make();
      const release = yield* Deferred.make<void>();
      const owner = yield* Effect.forkChild(
        latestVersions.cached(
          "cli",
          Deferred.await(release).pipe(Effect.andThen(Effect.fail("offline"))),
        ),
        { startImmediately: true },
      );
      let retries = 0;
      const waiter = yield* Effect.forkChild(
        latestVersions.cached(
          "cli",
          Effect.sync(() => {
            retries += 1;
            return "2.0.0";
          }),
        ),
        { startImmediately: true },
      );
      expect(retries).toBe(0);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Effect.flip(Fiber.join(owner))).toBe("offline");
      expect(yield* Fiber.join(waiter)).toBe("2.0.0");
      expect(retries).toBe(1);
    }),
  );

  it.effect("interrupting a waiter leaves the shared lookup running", () =>
    Effect.gen(function* () {
      const latestVersions = yield* ProviderLatestVersions.make();
      const release = yield* Deferred.make<void>();
      let lookups = 0;
      const lookup = Effect.suspend(() => {
        lookups += 1;
        return Deferred.await(release).pipe(Effect.as("2.0.0"));
      });
      const owner = yield* Effect.forkChild(latestVersions.cached("cli", lookup), {
        startImmediately: true,
      });
      const waiter = yield* Effect.forkChild(latestVersions.cached("cli", lookup), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(waiter);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(owner)).toBe("2.0.0");
      expect(yield* latestVersions.cached("cli", lookup)).toBe("2.0.0");
      expect(lookups).toBe(1);
    }),
  );
});
