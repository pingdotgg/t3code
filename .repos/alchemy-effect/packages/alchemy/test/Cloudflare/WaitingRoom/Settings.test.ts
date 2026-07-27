import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as waitingRooms from "@distilled.cloud/cloudflare/waiting-rooms";
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

// Enabling the crawler bypass requires a Waiting Rooms entitlement
// (Business/Enterprise + Advanced) — on the testing zone the PUT fails with
// the typed `ZoneNotEntitled` error (code 1034). GETs work on every plan,
// and a no-op reconcile never calls the PUT, so the baseline test below runs
// everywhere. The full toggle test is gated behind an entitled zone id.
const entitledZoneId = process.env.CLOUDFLARE_TEST_WAITING_ROOM_ZONE_ID;

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

const getSetting = (zoneId: string) =>
  waitingRooms.getSetting({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases mutate the same zone-level Waiting Room settings singleton; run them serially so they don't corrupt each other's captured baseline under the global concurrent test config.
describe("Settings", () => {
  test.provider(
    "pins the settings to the default baseline without touching the API",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // The zone's baseline is the Cloudflare default (false). Desired ==
        // observed, so reconcile skips the plan-gated PUT entirely — this
        // converges even on unentitled zones.
        const settings = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.WaitingRoom.Settings("Settings", {
              zoneId,
              searchEngineCrawlerBypass: false,
            });
          }),
        );

        expect(settings.zoneId).toEqual(zoneId);
        expect(settings.searchEngineCrawlerBypass).toEqual(false);
        // The pre-management value was captured for restore-on-destroy.
        expect(settings.initialSearchEngineCrawlerBypass).toEqual(false);

        // Out-of-band verification via the distilled API.
        const live = yield* getSetting(zoneId);
        expect(live.searchEngineCrawlerBypass).toEqual(false);

        // Destroy restores the initial value — also a no-op here.
        yield* stack.destroy();

        const restored = yield* getSetting(zoneId);
        expect(restored.searchEngineCrawlerBypass).toEqual(false);
      }).pipe(logLevel),
  );

  test.provider(
    "surfaces the typed ZoneNotEntitled error when enabling on unentitled zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // The plan-gated PUT must fail with the typed entitlement tag.
        const error = yield* waitingRooms
          .putSetting({ zoneId, searchEngineCrawlerBypass: true })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: forbiddenRetrySchedule,
              times: 8,
            }),
            Effect.flip,
          );
        expect(error._tag).toEqual("ZoneNotEntitled");

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  test.provider.skipIf(!entitledZoneId)(
    "enables the crawler bypass and restores the original value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = entitledZoneId!;

        yield* stack.destroy();
        // Known baseline: the bypass defaults to false.
        yield* waitingRooms.putSetting({
          zoneId,
          searchEngineCrawlerBypass: false,
        });

        const settings = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.WaitingRoom.Settings("Settings", {
              zoneId,
              searchEngineCrawlerBypass: true,
            });
          }),
        );

        expect(settings.searchEngineCrawlerBypass).toEqual(true);
        expect(settings.initialSearchEngineCrawlerBypass).toEqual(false);

        const live = yield* getSetting(zoneId);
        expect(live.searchEngineCrawlerBypass).toEqual(true);

        yield* stack.destroy();

        // Destroy restored the value the zone had before we managed it.
        const restored = yield* getSetting(zoneId);
        expect(restored.searchEngineCrawlerBypass).toEqual(false);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for these per-zone settings, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Assert the result is
  // non-empty and contains the standing test zone.
  test.provider("list enumerates the settings across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.WaitingRoom.Settings,
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
