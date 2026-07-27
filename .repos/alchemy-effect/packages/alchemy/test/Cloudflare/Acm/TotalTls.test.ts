import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/cloudflare/acm";
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

// Total TLS writes require the Advanced Certificate Manager add-on
// (~$10/mo per zone). The standard testing zone does not have it — every
// POST fails with the typed `AdvancedCertificateManagerRequired` (code
// 1450) error, while reads succeed and report `enabled: false`. The full
// enable/update/restore lifecycle is gated behind an entitled zone id
// supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_ACM_ZONE_ID;

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

// Freshly-minted scoped API tokens propagate eventually-consistently across
// Cloudflare's edge — ride out intermittent 403s via the typed `Forbidden`
// tag in each acm operation's error union.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getTotalTls = (zoneId: string) =>
  acm.getTotalTl({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases mutate the same zone-level Total TLS singleton; run them serially so they don't corrupt each other's captured `initialEnabled` under the global concurrent test config.
describe.sequential("TotalTls", () => {
  test.provider(
    "converges enabled:false as a no-op on a zone without the ACM entitlement",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // Total TLS defaults to disabled. Desiring `enabled: false` matches
        // the observed state, so reconcile never POSTs — the deploy succeeds
        // even though the zone lacks the ACM entitlement.
        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Acm.TotalTls("TotalTls", {
              zoneId,
              enabled: false,
            });
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.enabled).toEqual(false);
        // The pre-management state was captured for restore-on-destroy.
        expect(setting.initialEnabled).toEqual(false);

        // Out-of-band verification via the distilled API.
        const live = yield* getTotalTls(zoneId);
        expect(live.enabled ?? false).toEqual(false);

        // Destroy restores the (identical) baseline — also a no-op POST.
        yield* stack.destroy();
        const after = yield* getTotalTls(zoneId);
        expect(after.enabled ?? false).toEqual(false);
      }).pipe(logLevel),
  );

  test.provider(
    "surfaces the typed AdvancedCertificateManagerRequired error when enabling without the entitlement",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // Enabling Total TLS requires the ACM add-on; the distilled call
        // must fail with the typed entitlement tag (code 1450).
        const error = yield* acm.updateTotalTl({ zoneId, enabled: true }).pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
        expect(error._tag).toEqual("AdvancedCertificateManagerRequired");

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  test.provider.skipIf(!entitledZoneId)(
    "enables Total TLS, updates the CA in place, and restores the baseline on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = entitledZoneId!;

        yield* stack.destroy();
        // Known baseline: disabled.
        const baseline = yield* getTotalTls(zoneId);

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Acm.TotalTls("TotalTls", {
              zoneId,
              enabled: true,
            });
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.enabled).toEqual(true);
        expect(setting.initialEnabled).toEqual(baseline.enabled ?? false);

        // Out-of-band verification.
        const live = yield* getTotalTls(zoneId);
        expect(live.enabled).toEqual(true);

        // Update in place — pin the issuing Certificate Authority. The
        // singleton's identity (zoneId) is unchanged.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Acm.TotalTls("TotalTls", {
              zoneId,
              enabled: true,
              certificateAuthority: "lets_encrypt",
            });
          }),
        );
        expect(updated.enabled).toEqual(true);
        expect(updated.certificateAuthority).toEqual("lets_encrypt");
        expect(updated.initialEnabled).toEqual(baseline.enabled ?? false);

        // Destroy restores the pre-management state.
        yield* stack.destroy();
        const after = yield* getTotalTls(zoneId);
        expect(after.enabled ?? false).toEqual(baseline.enabled ?? false);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each (reads succeed without the
  // ACM entitlement). Assert the result is non-empty and contains the standing
  // test zone.
  test.provider("list enumerates the setting across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(Cloudflare.Acm.TotalTls);
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
