import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as contentScanning from "@distilled.cloud/cloudflare/content-scanning";
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

// WAF Content Scanning is an Enterprise paid add-on. On the testing
// account's zone, reading the status works (it reports "disabled"), but
// enabling fails with "not entitled to use the phase
// http_request_firewall_scan_file", surfaced as the typed
// `ContentScanningNotEntitled` error. The enable lifecycle test below is
// gated behind an entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_CONTENT_SCANNING_ZONE_ID;

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
// consistently across Cloudflare's edge — ride out 403 blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getStatus = (zoneId: string) =>
  contentScanning.getContentScanning({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const setBaseline = (zoneId: string, value: "enabled" | "disabled") =>
  contentScanning.putContentScanning({ zoneId, value }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases mutate the same zone-level content-scanning enablement singleton; run them serially so they don't corrupt each other's captured `initialValue` under the global concurrent test config.
describe.sequential("ContentScanning", () => {
  test.provider(
    "surfaces the typed ContentScanningNotEntitled error on unentitled zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // The standard testing zone lacks the Content Scanning add-on — the
        // distilled enable call must fail with the typed entitlement tag.
        const error = yield* contentScanning
          .putContentScanning({ zoneId, value: "enabled" })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: forbiddenRetrySchedule,
              times: 8,
            }),
            Effect.flip,
          );
        expect(error._tag).toEqual("ContentScanningNotEntitled");

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  test.provider(
    "pins Content Scanning off on an unentitled zone and destroys cleanly",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Known baseline: an unentitled zone reports "disabled" (the PUT to
        // "disabled" succeeds even without the add-on).
        yield* setBaseline(zoneId, "disabled");

        const scanning = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.ContentScanning.ContentScanning(
              "UploadScanning",
              {
                zoneId,
                enabled: false,
              },
            );
          }),
        );

        expect(scanning.zoneId).toEqual(zoneId);
        expect(scanning.enabled).toEqual(false);
        // The pre-management status was captured for restore-on-destroy.
        expect(scanning.initialValue).toEqual("disabled");

        // Out-of-band verification via the distilled API.
        const live = yield* getStatus(zoneId);
        expect(live.value).toEqual("disabled");

        // Re-deploying the same desired state is a pure no-op (no PUT) —
        // on an unentitled zone any write of "enabled" would fail, so this
        // also proves reconcile only calls the API on a delta.
        const again = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.ContentScanning.ContentScanning(
              "UploadScanning",
              {
                zoneId,
                enabled: false,
              },
            );
          }),
        );
        expect(again.enabled).toEqual(false);
        expect(again.initialValue).toEqual("disabled");

        yield* stack.destroy();

        // Destroy restored (kept) the pre-management status.
        const restored = yield* getStatus(zoneId);
        expect(restored.value).toEqual("disabled");
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Reading the status works
  // on every plan (only enabling is entitlement-gated), so this stays an
  // ungated read-only assertion. Assert the result is non-empty and contains
  // the standing test zone.
  test.provider("list enumerates the status across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.ContentScanning.ContentScanning,
      );
      // The freshly-minted scoped token propagates eventually-consistently, so
      // the account-wide enumeration intermittently 403s (`Forbidden`) or 401s
      // (`Unauthorized`). Both are transient here — ride out the blip like
      // every other out-of-band call in this suite.
      const all = yield* provider.list().pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden" || e._tag === "Unauthorized",
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

  test.provider.skipIf(!entitledZoneId)(
    "enables Content Scanning and restores the original status on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = entitledZoneId!;

        yield* stack.destroy();
        // Known baseline: Content Scanning defaults to "disabled".
        yield* setBaseline(zoneId, "disabled");

        const scanning = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.ContentScanning.ContentScanning(
              "UploadScanning",
              {
                zoneId,
              },
            );
          }),
        );

        expect(scanning.zoneId).toEqual(zoneId);
        expect(scanning.enabled).toEqual(true);
        expect(scanning.initialValue).toEqual("disabled");

        const live = yield* getStatus(zoneId);
        expect(live.value).toEqual("enabled");

        // Update in place — same singleton, initialValue survives.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.ContentScanning.ContentScanning(
              "UploadScanning",
              {
                zoneId,
                enabled: false,
              },
            );
          }),
        );
        expect(updated.enabled).toEqual(false);
        expect(updated.initialValue).toEqual("disabled");

        yield* stack.destroy();

        // Destroy restored the status the zone had before we managed it.
        const restored = yield* getStatus(zoneId);
        expect(restored.value).toEqual("disabled");
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
});
