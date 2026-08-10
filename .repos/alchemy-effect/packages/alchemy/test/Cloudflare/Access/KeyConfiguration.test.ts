import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "pins the rotation interval, updates in place, and restores on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Known baseline so each run starts from the same cloud state
      // regardless of what a previous (possibly interrupted) run left.
      yield* zeroTrust.putAccessKey({
        accountId,
        keyRotationIntervalDays: 90,
      });

      const keys = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.KeyConfiguration("Keys", {
            keyRotationIntervalDays: 45,
          });
        }),
      );

      expect(keys.accountId).toEqual(accountId);
      expect(keys.keyRotationIntervalDays).toEqual(45);
      // The pre-management interval was captured for restore-on-destroy.
      expect(keys.initialKeyRotationIntervalDays).toEqual(90);

      const live = yield* zeroTrust.getAccessKey({ accountId });
      expect(live.keyRotationIntervalDays).toEqual(45);

      // Update — the singleton converges in place and the captured
      // initial interval survives the update.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.KeyConfiguration("Keys", {
            keyRotationIntervalDays: 60,
          });
        }),
      );
      expect(updated.keyRotationIntervalDays).toEqual(60);
      expect(updated.initialKeyRotationIntervalDays).toEqual(90);

      const liveUpdated = yield* zeroTrust.getAccessKey({ accountId });
      expect(liveUpdated.keyRotationIntervalDays).toEqual(60);

      yield* stack.destroy();

      // Destroy restored the interval the account had before management.
      const restored = yield* zeroTrust.getAccessKey({ accountId });
      expect(restored.keyRotationIntervalDays).toEqual(90);
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Canonical `list()` test (per-account singleton): the key configuration
// always exists with a Cloudflare default and there is no enumeration API,
// so `list()` reads the single instance and returns it as a one-element
// array. Assert exactly one well-typed item scoped to the account.
test.provider(
  "list returns the account key configuration singleton",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const provider = yield* Provider.findProvider(
        Cloudflare.Access.KeyConfiguration,
      );
      const all = yield* provider.list();

      expect(all.length).toBe(1);
      expect(all[0]!.accountId).toEqual(accountId);
    }).pipe(logLevel),
  { timeout: 90_000 },
);
