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

// Enabling account-level custom nameservers (ACNS) on a zone requires an
// account nameserver set to exist first — a Business/Enterprise feature the
// testing account does not have. The enable/disable lifecycle below is
// gated behind a zone id (in an ACNS-entitled account) supplied via env.
const acnsZoneId = process.env.CLOUDFLARE_TEST_ACNS_ZONE_ID;

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
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
// Ride out the blips on the test's own out-of-band calls by retrying the
// typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCustomNs = (zoneId: string) =>
  zones.getCustomNameserver({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "pins the custom nameserver toggle and leaves the zone at its baseline on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // Baseline: the testing zone never has ACNS enabled (the account has
      // no custom nameserver set), so `enabled: false` is the observed
      // pre-management state the resource must capture and converge on.
      const baseline = yield* getCustomNs(zoneId);
      expect(baseline.enabled ?? false).toEqual(false);

      const customNs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.CustomNameservers("CustomNs", {
            zoneId,
            enabled: false,
          });
        }),
      );

      expect(customNs.zoneId).toEqual(zoneId);
      expect(customNs.enabled).toEqual(false);
      // The pre-management state was captured for restore-on-destroy.
      expect(customNs.initialEnabled).toEqual(false);
      expect(customNs.initialNsSet).toBeUndefined();

      const live = yield* getCustomNs(zoneId);
      expect(live.enabled ?? false).toEqual(false);

      // Re-deploy with no changes — reconcile observes the in-sync state
      // and applies nothing.
      const steady = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.CustomNameservers("CustomNs", {
            zoneId,
            enabled: false,
          });
        }),
      );
      expect(steady.enabled).toEqual(false);
      expect(steady.initialEnabled).toEqual(false);

      yield* stack.destroy();

      // Destroy restored (kept) the zone's pre-management state.
      const restored = yield* getCustomNs(zoneId);
      expect(restored.enabled ?? false).toEqual(false);
    }).pipe(logLevel),
);

test.provider(
  "surfaces the typed CustomNameserverSetNotFound error when enabling without an account nameserver set",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The testing account has no account-level custom nameserver set, so
      // enabling ACNS on the zone must fail with the typed gate error.
      const error = yield* zones
        .putCustomNameserver({ zoneId, enabled: true })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("CustomNameserverSetNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped singleton). There is no account-wide
// API for the per-zone ACNS toggle, so `list()` enumerates every zone via
// `listAllZones` and reads the singleton in each — emitting one Attributes
// only for zones that actively use account custom nameservers (skipping the
// default-disabled ones, mirroring `read`). The read-only shape assertion
// always runs; the testing account has no ACNS entitlement, so the array is
// typically empty.
test.provider(
  "list enumerates zones using account custom nameservers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Zone.CustomNameservers,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const item of all) {
        expect(typeof item.zoneId).toBe("string");
        // `list()` only emits zones with ACNS actively enabled.
        expect(item.enabled).toBe(true);
        expect(typeof item.initialEnabled).toBe("boolean");
        expect(item.nsSet === undefined || typeof item.nsSet === "number").toBe(
          true,
        );
        expect(
          item.initialNsSet === undefined ||
            typeof item.initialNsSet === "number",
        ).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
);

// In an ACNS-entitled account, `list()` must surface the enabled zone.
test.provider.skipIf(!acnsZoneId)(
  "list includes a zone with account custom nameservers enabled",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = acnsZoneId!;

      yield* stack.destroy();

      const enabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.CustomNameservers("AcnsList", {
            zoneId,
            enabled: true,
          });
        }),
      );
      expect(enabled.enabled).toEqual(true);

      const provider = yield* Provider.findProvider(
        Cloudflare.Zone.CustomNameservers,
      );
      const all = yield* provider.list();
      expect(all.some((x) => x.zoneId === zoneId && x.enabled)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!acnsZoneId)(
  "enables account custom nameservers and restores the baseline on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = acnsZoneId!;

      yield* stack.destroy();

      const enabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.CustomNameservers("AcnsToggle", {
            zoneId,
            enabled: true,
          });
        }),
      );
      expect(enabled.enabled).toEqual(true);
      expect(enabled.initialEnabled).toEqual(false);

      const live = yield* getCustomNs(zoneId);
      expect(live.enabled).toEqual(true);

      yield* stack.destroy();

      // Destroy restored the zone to Cloudflare-assigned nameservers.
      const restored = yield* getCustomNs(zoneId);
      expect(restored.enabled ?? false).toEqual(false);
    }).pipe(logLevel),
);
