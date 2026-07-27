import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as originTls from "@distilled.cloud/cloudflare/origin-tls-client-auth";
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
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error (part of
// each operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSetting = (zoneId: string) =>
  originTls.getSetting({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the singleton to a known baseline so each run starts from the
// same cloud state regardless of what a previous (possibly interrupted) run
// left behind.
const setBaseline = (zoneId: string, enabled: boolean) =>
  originTls.putSetting({ zoneId, enabled }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases toggle the same zone-level AOP singleton; run them serially so they don't corrupt each other's captured `initialEnabled` under the global concurrent test config.
describe.sequential("Setting", () => {
  test.provider(
    "enables AOP and restores the original value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Known baseline: zone-level AOP defaults to disabled.
        yield* setBaseline(zoneId, false);

        const setting = yield* stack.deploy(
          Cloudflare.OriginTlsClientAuth.Setting("Aop", {
            zoneId,
            enabled: true,
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.enabled).toEqual(true);
        // The pre-management value is captured for restore-on-destroy.
        expect(setting.initialEnabled).toEqual(false);

        const observed = yield* getSetting(zoneId);
        expect(observed.enabled).toEqual(true);

        yield* stack.destroy();

        // Destroy restores the captured baseline, not a hardcoded default.
        const restored = yield* getSetting(zoneId);
        expect(restored.enabled).toEqual(false);
      }).pipe(logLevel),
  );

  test.provider("updates the enabled flag in place", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* setBaseline(zoneId, false);

      const enabled = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuth.Setting("AopUpdate", {
          zoneId,
          enabled: true,
        }),
      );
      expect(enabled.enabled).toEqual(true);
      expect(enabled.initialEnabled).toEqual(false);

      // In-place update — the singleton is never replaced.
      const disabled = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuth.Setting("AopUpdate", {
          zoneId,
          enabled: false,
        }),
      );
      expect(disabled.enabled).toEqual(false);
      // The original baseline survives the update.
      expect(disabled.initialEnabled).toEqual(false);

      const observed = yield* getSetting(zoneId);
      expect(observed.enabled).toEqual(false);

      yield* stack.destroy();

      const restored = yield* getSetting(zoneId);
      expect(restored.enabled).toEqual(false);
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
        Cloudflare.OriginTlsClientAuth.Setting,
      );
      // Ride out fresh-token 403 blips on the account-wide enumeration, like
      // every other out-of-band call in this suite.
      const all = yield* provider.list().pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
      );

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
