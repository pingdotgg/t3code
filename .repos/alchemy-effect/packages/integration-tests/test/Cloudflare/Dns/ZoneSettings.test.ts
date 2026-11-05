import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

// Ride out fresh-token 403 blips on out-of-band calls by retrying the typed
// `Forbidden` error (added to the dns ops' unions via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const retryForbidden = <A, E extends { _tag: string }, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const getSettings = (zoneId: string) => retryForbidden(dns.getSettingZone({ zoneId }));

// Baselines for the (entitlement-free) fields these tests manage.
// NOTE: `nsTtl` and custom SOA records are entitlement-gated on the testing
// account ("Custom nameserver TTLs / Custom SOA records are not available to
// this account or zone"), so the tests exercise `flattenAllCnames` and
// `multiProvider` instead.
const BASELINE_FLATTEN_ALL_CNAMES = false;
const BASELINE_MULTI_PROVIDER = false;

// Normalize the singleton to a known baseline so each run starts from the
// same cloud state regardless of what a previous (possibly interrupted) run
// left behind. Patches only when something actually drifted.
const normalizeBaseline = (zoneId: string) =>
  Effect.gen(function* () {
    const observed = yield* getSettings(zoneId);
    if (
      observed.flattenAllCnames === BASELINE_FLATTEN_ALL_CNAMES &&
      observed.multiProvider === BASELINE_MULTI_PROVIDER
    ) {
      return;
    }
    yield* retryForbidden(
      dns.patchSettingZone({
        zoneId,
        flattenAllCnames: BASELINE_FLATTEN_ALL_CNAMES,
        multiProvider: BASELINE_MULTI_PROVIDER,
      }),
    );
  });

describe.sequential(
  "ZoneSettings",
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
  () => {
    test.provider(
      "pins flattenAllCnames and restores the pre-management value on destroy",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          yield* stack.destroy();
          yield* normalizeBaseline(zoneId);

          const settings = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
                zoneId,
                flattenAllCnames: true,
              });
            }),
          );

          expect(settings.zoneId).toEqual(zoneId);
          expect(settings.flattenAllCnames).toEqual(true);
          // The pre-management snapshot was captured for restore-on-destroy.
          expect(settings.initialSettings.flattenAllCnames).toEqual(BASELINE_FLATTEN_ALL_CNAMES);
          expect(settings.managedKeys).toContain("flattenAllCnames");

          // Out-of-band verify via the SDK.
          const live = yield* getSettings(zoneId);
          expect(live.flattenAllCnames).toEqual(true);

          yield* stack.destroy();

          // Destroy restored the managed field to its pre-management value.
          const restored = yield* getSettings(zoneId);
          expect(restored.flattenAllCnames).toEqual(BASELINE_FLATTEN_ALL_CNAMES);

          // Re-running destroy is idempotent (nothing left to restore).
          yield* stack.destroy();
          const still = yield* getSettings(zoneId);
          expect(still.flattenAllCnames).toEqual(BASELINE_FLATTEN_ALL_CNAMES);
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "updates in place, unions managedKeys, restores all managed fields",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          yield* stack.destroy();
          yield* normalizeBaseline(zoneId);

          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
                zoneId,
                multiProvider: true,
              });
            }),
          );
          expect(initial.multiProvider).toEqual(true);
          expect(initial.initialSettings.multiProvider).toEqual(BASELINE_MULTI_PROVIDER);
          expect(initial.managedKeys).toContain("multiProvider");

          // Same singleton patched in place — new value plus a second managed
          // field; the original snapshot survives the update.
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
                zoneId,
                multiProvider: true,
                flattenAllCnames: true,
              });
            }),
          );
          expect(updated.zoneId).toEqual(zoneId);
          expect(updated.multiProvider).toEqual(true);
          expect(updated.flattenAllCnames).toEqual(true);
          expect(updated.initialSettings.multiProvider).toEqual(BASELINE_MULTI_PROVIDER);
          expect(updated.initialSettings.flattenAllCnames).toEqual(BASELINE_FLATTEN_ALL_CNAMES);
          expect(updated.managedKeys).toContain("multiProvider");
          expect(updated.managedKeys).toContain("flattenAllCnames");

          const live = yield* getSettings(zoneId);
          expect(live.multiProvider).toEqual(true);
          expect(live.flattenAllCnames).toEqual(true);

          // Drop `multiProvider` from props — the key stays managed (union
          // across all reconciles) so destroy still restores it.
          const dropped = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
                zoneId,
                flattenAllCnames: true,
              });
            }),
          );
          expect(dropped.managedKeys).toContain("multiProvider");
          expect(dropped.managedKeys).toContain("flattenAllCnames");

          yield* stack.destroy();

          // Both managed fields were restored to their pre-management values.
          const restored = yield* getSettings(zoneId);
          expect(restored.multiProvider).toEqual(BASELINE_MULTI_PROVIDER);
          expect(restored.flattenAllCnames).toEqual(BASELINE_FLATTEN_ALL_CNAMES);
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    // Regression for #1982: Cloudflare stops accepting/returning
    // `foundation_dns` on 2026-11-23. Advanced Nameservers are expressed via
    // `nameservers.type`, and the resource never sends or snapshots the
    // removed boolean. The nameserver type is pinned to its observed value —
    // flipping the standing test zone's nameservers would break delegation.
    test.provider(
      "manages nameservers.type without foundationDns (#1982)",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          yield* stack.destroy();
          yield* normalizeBaseline(zoneId);
          const baseline = yield* getSettings(zoneId);

          const settings = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
                zoneId,
                nameservers: { type: baseline.nameservers.type },
                flattenAllCnames: true,
              });
            }),
          );

          expect(settings.nameservers.type).toEqual(baseline.nameservers.type);
          expect(settings.flattenAllCnames).toEqual(true);
          expect(settings.managedKeys).toContain("nameservers");
          expect(settings.managedKeys).not.toContain("foundationDns");
          expect("foundationDns" in settings).toBe(false);
          expect("foundationDns" in settings.initialSettings).toBe(false);

          const live = yield* getSettings(zoneId);
          expect(live.nameservers.type).toEqual(baseline.nameservers.type);
          expect(live.flattenAllCnames).toEqual(true);

          // A redeploy with nothing changed converges without a PATCH.
          const redeployed = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
                zoneId,
                nameservers: { type: baseline.nameservers.type },
                flattenAllCnames: true,
              });
            }),
          );
          expect(redeployed.flattenAllCnames).toEqual(true);

          yield* stack.destroy();

          const restored = yield* getSettings(zoneId);
          expect(restored.flattenAllCnames).toEqual(BASELINE_FLATTEN_ALL_CNAMES);
          expect(restored.nameservers.type).toEqual(baseline.nameservers.type);
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    // Canonical `list()` test (zone-scoped singleton): there is no account-wide
    // API for this per-zone settings object, so `list()` enumerates every zone
    // via `listAllZones` and reads the singleton in each. Assert the result is
    // non-empty and contains the standing test zone.
    test.provider("list enumerates DNS settings across all zones", (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        const provider = yield* Provider.findProvider(Cloudflare.DNS.ZoneDnsSettings);
        const all = yield* provider.list();

        expect(all.length).toBeGreaterThan(0);
        expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

        // `stack` is unused here (the singleton always exists on every zone),
        // but keep the destroy bookend so the harness state stays clean.
        yield* stack.destroy();
      }).pipe(logLevel),
    );
  },
);
