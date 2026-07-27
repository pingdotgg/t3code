import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cache from "@distilled.cloud/cloudflare/cache";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
// Ride out the blips on the test's own out-of-band calls by retrying the
// typed `Forbidden` error (part of each cache operation's error union via
// distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSmartTieredCache = (zoneId: string) =>
  cache.getSmartTieredCache({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the setting to a known baseline so each run starts from the
// same cloud state regardless of what a previous (possibly interrupted)
// run left behind. Smart Tiered Cache defaults to "off".
const setBaseline = (zoneId: string, value: "on" | "off") =>
  cache.patchSmartTieredCache({ zoneId, value }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases mutate the same zone-level Smart Tiered Cache singleton with
// opposite baselines; run them serially so they don't corrupt each other's
// captured `initialValue` under the global concurrent test config.
describe.sequential("SmartTieredCache", () => {
  test.provider(
    "enables Smart Tiered Cache and restores the original value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Known baseline: Smart Tiered Cache defaults to "off".
        yield* setBaseline(zoneId, "off");

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.SmartTieredCache("SmartCache", {
              zoneId,
            });
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.value).toEqual("on");
        // The pre-management value was captured for restore-on-destroy.
        expect(setting.initialValue).toEqual("off");
        expect(setting.editable).toEqual(true);

        // Out-of-band verification via the distilled API.
        const live = yield* getSmartTieredCache(zoneId);
        expect(live.value).toEqual("on");

        yield* stack.destroy();

        // Destroy restored the value the setting had before we managed it.
        const restored = yield* getSmartTieredCache(zoneId);
        expect(restored.value).toEqual("off");
      }).pipe(logLevel),
  );

  test.provider(
    "updates the setting in place and keeps the captured initial value",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Known baseline: start from "on" so initialValue !== first desired
        // value and the restore path is observable.
        yield* setBaseline(zoneId, "on");

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.SmartTieredCache("SmartCache", {
              zoneId,
              enabled: false,
            });
          }),
        );

        expect(initial.value).toEqual("off");
        expect(initial.initialValue).toEqual("on");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.SmartTieredCache("SmartCache", {
              zoneId,
              enabled: true,
            });
          }),
        );

        // Same singleton patched in place; the original value survives the
        // update so destroy still restores the pre-management state.
        expect(updated.value).toEqual("on");
        expect(updated.initialValue).toEqual("on");

        const live = yield* getSmartTieredCache(zoneId);
        expect(live.value).toEqual("on");

        yield* stack.destroy();

        const restored = yield* getSmartTieredCache(zoneId);
        expect(restored.value).toEqual("on");

        // Leave the zone at its Cloudflare default ("off") for other suites.
        yield* setBaseline(zoneId, "off");
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Assert the result is
  // non-empty and contains the standing test zone.
  test.provider("list enumerates the setting across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.Cache.SmartTieredCache,
      );
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookends so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
