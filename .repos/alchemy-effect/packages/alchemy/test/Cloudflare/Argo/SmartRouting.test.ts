import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as argo from "@distilled.cloud/cloudflare/argo";
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

// Argo Smart Routing is a paid, usage-billed add-on. On the testing
// account's zone every GET/PATCH of `/argo/smart_routing` fails with
// Cloudflare code 1015 ("The request is not authorized to access this
// setting. Cause(s): smart_routing"), surfaced as the typed
// `NotAuthorized` error. The full lifecycle test below is gated behind an
// Argo-entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_ARGO_ZONE_ID;

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
// consistently across Cloudflare's edge — a fresh token intermittently
// 403s with "Unable to authenticate request". Ride out the blips on the
// test's own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSmartRouting = (zoneId: string) =>
  argo.getSmartRouting({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the singleton to a known baseline so each run starts from the
// same cloud state regardless of what a previous (possibly interrupted)
// run left behind.
const setBaseline = (zoneId: string, value: "on" | "off") =>
  argo.patchSmartRouting({ zoneId, value }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("SmartRouting", () => {
  test.provider(
    "surfaces the typed NotAuthorized error on zones without the Argo add-on",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // The standard testing zone lacks the paid Argo subscription — the
        // distilled call must fail with the typed entitlement tag (1015).
        const error = yield* getSmartRouting(zoneId).pipe(Effect.flip);
        expect(error._tag).toEqual("NotAuthorized");

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  test.provider.skipIf(!entitledZoneId)(
    "enables Smart Routing and restores the original value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = entitledZoneId!;

        yield* stack.destroy();
        // Known baseline: smart routing off before we manage it.
        yield* setBaseline(zoneId, "off");

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Argo.SmartRouting("SmartRouting", {
              zoneId,
            });
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.value).toEqual("on");
        // The pre-management value was captured for restore-on-destroy.
        expect(setting.initialValue).toEqual("off");

        // Out-of-band verification via the distilled API.
        const live = yield* getSmartRouting(zoneId);
        expect(live.value).toEqual("on");

        // Update in place — same singleton, initialValue survives.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Argo.SmartRouting("SmartRouting", {
              zoneId,
              enabled: false,
            });
          }),
        );
        expect(updated.value).toEqual("off");
        expect(updated.initialValue).toEqual("off");

        yield* stack.destroy();

        // Destroy restored the value the setting had before we managed it.
        const restored = yield* getSmartRouting(zoneId);
        expect(restored.value).toEqual("off");
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each, skipping zones without the
  // paid Argo subscription (typed `NotAuthorized`, code 1015). On the standard
  // testing account no zone is Argo-entitled, so `list()` returns an empty
  // array without throwing; when an entitled zone id is supplied via env, its
  // entry must be present.
  test.provider("list enumerates Argo-entitled zones", (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.Argo.SmartRouting,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Every returned entry is a real, entitled zone's setting.
      for (const row of all) {
        expect(typeof row.zoneId).toBe("string");
        expect(["on", "off"]).toContain(row.value);
      }
      if (entitledZoneId) {
        expect(all.some((s) => s.zoneId === entitledZoneId)).toBe(true);
      }

      // `stack` is unused here (the singleton always exists on every
      // entitled zone); keep the destroy bookend so harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
