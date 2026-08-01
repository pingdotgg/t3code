import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zones from "@distilled.cloud/cloudflare/zones";
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

// Zone holds are Enterprise-only. On the testing account's zone every
// createHold/patchHold fails with Cloudflare code 1005 ("Zone holds are only
// available on Enterprise zones (1005)"), surfaced as the typed
// `ZoneHoldsRequireEnterprise` error. The full lifecycle test below is gated
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

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getHold = (zoneId: string) =>
  zones.getHold({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize to a no-hold baseline so each run starts from the same cloud
// state regardless of what a previous (possibly interrupted) run left behind.
// deleteHold is naturally idempotent — it succeeds even when no hold exists.
const removeHoldBaseline = (zoneId: string) =>
  zones.deleteHold({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const isHeld = (hold: zones.GetHoldResponse): boolean => hold.hold === true;

const includesSubdomains = (hold: zones.GetHoldResponse): boolean =>
  hold.includeSubdomains === true || hold.includeSubdomains === "true";

test.provider(
  "surfaces the typed ZoneHoldsRequireEnterprise error on non-Enterprise zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // getHold works on every plan and reports the zone as not held.
      const observed = yield* getHold(zoneId);
      expect(isHeld(observed)).toBe(false);

      // deleteHold is idempotent — removing a non-existent hold succeeds.
      yield* removeHoldBaseline(zoneId);

      // Placing a hold on a non-Enterprise zone fails with the typed
      // entitlement tag.
      const error = yield* zones.createHold({ zoneId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
        Effect.flip,
      );
      expect(error._tag).toEqual("ZoneHoldsRequireEnterprise");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped singleton): a hold is a per-zone
// singleton — `getHold` returns a record for every zone — and there is no
// account-wide enumeration API, so `list()` enumerates every zone via
// `listAllZones` and reads the hold state in each. Assert the result is
// non-empty and contains the standing test zone. This works on any plan
// (reading the hold state needs no Enterprise entitlement).
test.provider("list enumerates the hold state across all zones", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Cloudflare.Zone.Hold);
    const all = yield* provider.list();

    expect(all.length).toBeGreaterThan(0);
    expect(all.some((h) => h.zoneId === zoneId)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(!enterpriseZoneId)(
  "places a hold, updates includeSubdomains in place, and removes it on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = enterpriseZoneId!;

      yield* stack.destroy();
      // Known baseline: no hold on the zone.
      yield* removeHoldBaseline(zoneId);

      const hold = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.Hold("Hold", {
            zoneId,
          });
        }),
      );

      expect(hold.zoneId).toEqual(zoneId);
      expect(hold.hold).toBe(true);
      expect(hold.includeSubdomains).toBe(false);

      // Out-of-band verification via the distilled API.
      const live = yield* getHold(zoneId);
      expect(isHeld(live)).toBe(true);
      expect(includesSubdomains(live)).toBe(false);

      // Update in place — extend the hold to subdomains via patchHold.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.Hold("Hold", {
            zoneId,
            includeSubdomains: true,
          });
        }),
      );

      expect(updated.hold).toBe(true);
      expect(updated.includeSubdomains).toBe(true);

      const liveUpdated = yield* getHold(zoneId);
      expect(isHeld(liveUpdated)).toBe(true);
      expect(includesSubdomains(liveUpdated)).toBe(true);

      yield* stack.destroy();

      // Destroy removed the hold.
      const removed = yield* getHold(zoneId);
      expect(isHeld(removed)).toBe(false);
    }).pipe(logLevel),
);
