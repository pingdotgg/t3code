import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as pageShield from "@distilled.cloud/cloudflare/page-shield";
import { expect } from "alchemy-test";
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

// Fresh scoped tokens propagate eventually-consistently across Cloudflare's
// edge — retry the typed `Forbidden` error on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSettings = (zoneId: string) =>
  pageShield.getPageShield({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Known baseline for the singleton: Page Shield off, API defaults for the
// reporting flags. Tests start from here so `initial*` capture is
// deterministic, and destroy must put the zone back here.
const setBaseline = (zoneId: string) =>
  pageShield
    .putPageShield({
      zoneId,
      enabled: false,
      useCloudflareReportingEndpoint: true,
      useConnectionUrlPath: false,
    })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );

test.provider(
  "enables Page Shield, updates in place, and restores the baseline on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* setBaseline(zoneId);

      // Create — enable Page Shield with defaults.
      const settings = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.PageShield.Settings("PageShield", {
            zoneId,
          });
        }),
      );

      expect(settings.zoneId).toEqual(zoneId);
      expect(settings.enabled).toEqual(true);
      expect(settings.useCloudflareReportingEndpoint).toEqual(true);
      expect(settings.useConnectionUrlPath).toEqual(false);
      // The pre-management state was captured for restore-on-destroy.
      expect(settings.initialEnabled).toEqual(false);
      expect(settings.initialUseCloudflareReportingEndpoint).toEqual(true);
      expect(settings.initialUseConnectionUrlPath).toEqual(false);

      // Out-of-band verification via the distilled API.
      const live = yield* getSettings(zoneId);
      expect(live.enabled).toEqual(true);

      // Update in place — flip `enabled` (the only flag writable without
      // extra entitlements on the test zone); same singleton, initial*
      // survive.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.PageShield.Settings("PageShield", {
            zoneId,
            enabled: false,
          });
        }),
      );
      expect(updated.enabled).toEqual(false);
      expect(updated.initialEnabled).toEqual(false);

      const liveDisabled = yield* getSettings(zoneId);
      expect(liveDisabled.enabled).toEqual(false);

      // And back on — the last managed state differs from the baseline,
      // so the restore below is observable.
      const reenabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.PageShield.Settings("PageShield", {
            zoneId,
            enabled: true,
          });
        }),
      );
      expect(reenabled.enabled).toEqual(true);
      expect(reenabled.initialEnabled).toEqual(false);

      const liveReenabled = yield* getSettings(zoneId);
      expect(liveReenabled.enabled).toEqual(true);

      yield* stack.destroy();

      // Destroy restored the configuration the zone had before us.
      const restored = yield* getSettings(zoneId);
      expect(restored.enabled).toEqual(false);
      expect(restored.useCloudflareReportingEndpoint).toEqual(true);
      expect(restored.useConnectionUrlPath).toEqual(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "surfaces the typed NotEntitled error for plan-gated flags",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The test zone lacks the connection-monitor entitlement — the
      // distilled call must fail with the typed entitlement tag.
      const error = yield* pageShield
        .putPageShield({
          zoneId,
          enabled: true,
          useCloudflareReportingEndpoint: true,
          useConnectionUrlPath: true,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("NotEntitled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped singleton): there is no account-wide
// API for this per-zone configuration, so `list()` enumerates every zone via
// `listAllZones` and reads the singleton in each. Assert the result is
// non-empty and contains the standing test zone.
test.provider(
  "list enumerates Page Shield settings across all zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.PageShield.Settings,
      );
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
