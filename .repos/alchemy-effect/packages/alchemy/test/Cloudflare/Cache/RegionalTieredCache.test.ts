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

// Regional Tiered Cache is Enterprise-only. On the testing account's zone
// every GET/PATCH fails with Cloudflare code 1135 ("Sorry, this zone setting
// is not available for your plan type."), surfaced as the typed
// `SettingUnavailableForPlan` error. The full lifecycle test below is gated
// behind an Enterprise zone id supplied via env.
const enterpriseZoneId = process.env.CLOUDFLARE_TEST_ENTERPRISE_ZONE_ID;

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

const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getRegionalTieredCache = (zoneId: string) =>
  cache.getRegionalTieredCache({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const setBaseline = (zoneId: string, value: "on" | "off") =>
  cache.patchRegionalTieredCache({ zoneId, value }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases mutate the same zone-level Regional Tiered Cache singleton; run them serially so they don't corrupt each other's captured `initialValue` under the global concurrent test config.
describe.sequential("RegionalTieredCache", () => {
  test.provider(
    "surfaces the typed SettingUnavailableForPlan error on non-Enterprise zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // The standard testing zone is plan-gated — both the out-of-band
        // distilled call and a deploy must fail with the typed tag.
        const error = yield* cache.getRegionalTieredCache({ zoneId }).pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
        expect(error._tag).toEqual("SettingUnavailableForPlan");

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  test.provider.skipIf(!enterpriseZoneId)(
    "enables Regional Tiered Cache and restores the original value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = enterpriseZoneId!;

        yield* stack.destroy();
        // Known baseline: Regional Tiered Cache defaults to "off".
        yield* setBaseline(zoneId, "off");

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.RegionalTieredCache(
              "RegionalCache",
              {
                zoneId,
              },
            );
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.value).toEqual("on");
        // The pre-management value was captured for restore-on-destroy.
        expect(setting.initialValue).toEqual("off");

        // Out-of-band verification via the distilled API.
        const live = yield* getRegionalTieredCache(zoneId);
        expect(live.value).toEqual("on");

        // Update in place — same singleton, initialValue survives.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.RegionalTieredCache(
              "RegionalCache",
              {
                zoneId,
                enabled: false,
              },
            );
          }),
        );
        expect(updated.value).toEqual("off");
        expect(updated.initialValue).toEqual("off");

        yield* stack.destroy();

        // Destroy restored the value the setting had before we managed it.
        const restored = yield* getRegionalTieredCache(zoneId);
        expect(restored.value).toEqual("off");
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Regional Tiered Cache is
  // Enterprise-only, so non-entitled zones surface `SettingUnavailableForPlan`
  // and are skipped — on a non-Enterprise account the result is well-formed
  // (often empty). The "contains the test zone" assertion only holds when an
  // Enterprise zone id is supplied via env.
  test.provider("list enumerates the setting across entitled zones", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Cache.RegionalTieredCache,
      );
      const all = yield* provider.list();

      // Always well-formed: an array whose entries match the Attributes shape.
      expect(Array.isArray(all)).toBe(true);
      for (const row of all) {
        expect(typeof row.zoneId).toBe("string");
        expect(typeof row.value).toBe("string");
      }

      // On an Enterprise account, the entitled zone is enumerated.
      if (enterpriseZoneId) {
        expect(all.some((s) => s.zoneId === enterpriseZoneId)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
