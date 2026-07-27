import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ssl from "@distilled.cloud/cloudflare/ssl";
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
// each universal-setting operation's error union via distilled patches).
//
// The universal-settings PATCH endpoint is also rate-limited per zone
// ("Rate limit reached for the update operation. Please try again in a
// minute"), which surfaces as the typed `TooManyRequests` — back off and
// retry that too. The exponential schedule reaches the ~1 minute window
// within the bounded attempts.
const transientRetrySchedule = Schedule.exponential("500 millis");

const getUniversal = (zoneId: string) =>
  ssl.getUniversalSetting({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden" || e._tag === "TooManyRequests",
      schedule: transientRetrySchedule,
      times: 8,
    }),
  );

// Normalize the setting to a known baseline so each run starts from the
// same cloud state regardless of what a previous (possibly interrupted)
// run left behind. Cloudflare's default for Universal SSL is enabled.
const setBaseline = (zoneId: string, enabled: boolean) =>
  ssl.patchUniversalSetting({ zoneId, enabled }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden" || e._tag === "TooManyRequests",
      schedule: transientRetrySchedule,
      times: 8,
    }),
  );

// Toggling Universal SSL off DELETES the standing zone's universal edge
// certificate; Cloudflare re-issues it minutes later on re-enable — and
// sometimes not at all (`enabled: true` with zero certificate packs), which
// breaks every TLS-dependent test on the shared zone (worker routes, R2
// domains, Hyperdrive origins) until someone re-orders the cert by toggling
// the setting off→on. The toggle lifecycle is therefore opt-in; the
// read-only `list` test below always runs.
const destructive = !!process.env.CLOUDFLARE_TEST_UNIVERSAL_SSL;

describe.sequential("UniversalSsl", () => {
  test.provider.skipIf(!destructive)(
    "disables Universal SSL and restores the original value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Known baseline: Universal SSL defaults to enabled.
        yield* setBaseline(zoneId, true);

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Ssl.UniversalSsl("UniversalSsl", {
              zoneId,
              enabled: false,
            });
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.enabled).toEqual(false);
        // The pre-management value was captured for restore-on-destroy.
        expect(setting.initialEnabled).toEqual(true);

        const live = yield* getUniversal(zoneId);
        expect(live.enabled).toEqual(false);

        yield* stack.destroy();

        // Destroy restored the value the setting had before we managed it.
        const restored = yield* getUniversal(zoneId);
        expect(restored.enabled).toEqual(true);
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  test.provider.skipIf(!destructive)(
    "updates enabled in place and keeps the captured initial value",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId, true);

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Ssl.UniversalSsl("UniversalSsl", {
              zoneId,
              enabled: false,
            });
          }),
        );

        expect(initial.enabled).toEqual(false);
        expect(initial.initialEnabled).toEqual(true);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Ssl.UniversalSsl("UniversalSsl", {
              zoneId,
              enabled: true,
            });
          }),
        );

        // Same singleton patched in place; the original value survives the
        // update so destroy still restores the pre-management state.
        expect(updated.enabled).toEqual(true);
        expect(updated.initialEnabled).toEqual(true);

        const live = yield* getUniversal(zoneId);
        expect(live.enabled).toEqual(true);

        yield* stack.destroy();

        const restored = yield* getUniversal(zoneId);
        expect(restored.enabled).toEqual(true);
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  test.provider.skipIf(!destructive)(
    "destroy restores a disabled baseline when managing from a disabled zone",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Pre-management state is disabled — the capture-and-restore must
        // bring the zone back to disabled, not to Cloudflare's default.
        yield* setBaseline(zoneId, false);

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Ssl.UniversalSsl("UniversalSsl", {
              zoneId,
              enabled: true,
            });
          }),
        );

        expect(setting.enabled).toEqual(true);
        expect(setting.initialEnabled).toEqual(false);

        const live = yield* getUniversal(zoneId);
        expect(live.enabled).toEqual(true);

        yield* stack.destroy();

        const restored = yield* getUniversal(zoneId);
        expect(restored.enabled).toEqual(false);

        // Leave the zone in its default state for other suites.
        yield* setBaseline(zoneId, true);
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Assert the result is
  // non-empty and contains the standing test zone.
  test.provider("list enumerates the setting across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.Ssl.UniversalSsl,
      );
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
