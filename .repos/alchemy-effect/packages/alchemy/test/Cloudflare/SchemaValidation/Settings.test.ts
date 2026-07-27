import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as schemaValidation from "@distilled.cloud/cloudflare/schema-validation";
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

// Retry 403 blips while the harness-minted scoped token propagates.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSettingOob = (zoneId: string) =>
  schemaValidation.getSetting({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the zone to the Cloudflare default so each run starts from the
// same cloud state regardless of what a previous run left behind.
const setBaseline = (zoneId: string) =>
  schemaValidation
    .putSetting({
      zoneId,
      validationDefaultMitigationAction: "none",
      validationOverrideMitigationAction: null,
    })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );

test.provider(
  "pins zone settings, updates in place, and restores the baseline on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* setBaseline(zoneId);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SchemaValidation.Settings("Settings", {
            zoneId,
            validationDefaultMitigationAction: "block",
          });
        }),
      );

      expect(created.zoneId).toEqual(zoneId);
      expect(created.validationDefaultMitigationAction).toEqual("block");
      expect(created.validationOverrideMitigationAction).toEqual(null);
      // The pre-management state was captured for restore-on-destroy.
      expect(created.initialDefaultMitigationAction).toEqual("none");
      expect(created.initialOverrideMitigationAction).toEqual(null);

      const live = yield* getSettingOob(zoneId);
      expect(live.validationDefaultMitigationAction).toEqual("block");

      // Update in place — flip on the zone-wide kill switch. The captured
      // initial state survives the update.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SchemaValidation.Settings("Settings", {
            zoneId,
            validationDefaultMitigationAction: "block",
            validationOverrideMitigationAction: "none",
          });
        }),
      );

      expect(updated.validationDefaultMitigationAction).toEqual("block");
      expect(updated.validationOverrideMitigationAction).toEqual("none");
      expect(updated.initialDefaultMitigationAction).toEqual("none");
      expect(updated.initialOverrideMitigationAction).toEqual(null);

      const liveUpdated = yield* getSettingOob(zoneId);
      expect(liveUpdated.validationOverrideMitigationAction).toEqual("none");

      yield* stack.destroy();

      // Destroy restored the values the zone had before we managed them.
      const restored = yield* getSettingOob(zoneId);
      expect(restored.validationDefaultMitigationAction).toEqual("none");
      expect(restored.validationOverrideMitigationAction ?? null).toEqual(null);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped singleton): there is no account-wide
// API for this per-zone setting, so `list()` enumerates every zone via
// `listAllZones` and reads the singleton in each. Assert the result is
// non-empty and contains the standing test zone.
test.provider(
  "list enumerates the schema validation settings across all zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.SchemaValidation.Settings,
      );
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // The singleton always exists on every zone, so nothing was deployed;
      // keep the destroy bookends so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
