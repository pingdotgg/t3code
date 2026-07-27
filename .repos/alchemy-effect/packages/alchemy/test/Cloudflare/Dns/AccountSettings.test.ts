import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Ride out fresh-token 403 blips on out-of-band calls.
const retryForbidden = <A, E extends { _tag: string }, R>(
  eff: Effect.Effect<A, E, R>,
) =>
  eff.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const getSettings = (accountId: string) =>
  retryForbidden(dns.getSettingAccount({ accountId }));

// Baselines for the (entitlement-free) zone-default fields these tests
// manage. NOTE: `zoneDefaults.nsTtl`, custom SOA values, and custom zone
// modes are entitlement-gated on the testing account (code 1003 — the
// typed `DnsSettingNotAvailable`), and `zoneDefaults.flattenAllCnames`
// is rejected outright ("Setting an account-level default for CNAME
// flattening is not supported"), so the tests exercise `multiProvider`
// and `secondaryOverrides` instead. These only affect defaults for
// FUTURE zones, so mutating them is safe on a shared test account.
const BASELINE_MULTI_PROVIDER = false;
const BASELINE_SECONDARY_OVERRIDES = false;

// Normalize the singleton to a known baseline so each run starts from
// the same cloud state regardless of what a previous (possibly
// interrupted) run left behind.
const normalizeBaseline = (accountId: string) =>
  Effect.gen(function* () {
    const observed = yield* getSettings(accountId);
    if (
      observed.zoneDefaults.multiProvider === BASELINE_MULTI_PROVIDER &&
      observed.zoneDefaults.secondaryOverrides === BASELINE_SECONDARY_OVERRIDES
    ) {
      return;
    }
    yield* retryForbidden(
      dns.patchSettingAccount({
        accountId,
        zoneDefaults: {
          multiProvider: BASELINE_MULTI_PROVIDER,
          secondaryOverrides: BASELINE_SECONDARY_OVERRIDES,
        },
      }),
    );
  });

describe.sequential("AccountSettings", () => {
  test.provider(
    "list returns the account's DNS settings singleton",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        // Account singleton — read-only enumeration, no mutation.
        yield* stack.destroy();

        const provider = yield* Provider.findProvider(
          Cloudflare.DNS.AccountDnsSettings,
        );
        const all = yield* provider.list();

        // Exactly the one account-wide settings object, fully typed.
        expect(all.length).toEqual(1);
        const [settings] = all;
        expect(settings.accountId).toEqual(accountId);
        expect(typeof settings.enforceDnsOnly).toEqual("boolean");
        expect(typeof settings.zoneDefaults.multiProvider).toEqual("boolean");
        // `read` mirror: nothing managed yet, snapshot is its own baseline.
        expect(settings.managedKeys).toEqual([]);
        expect(settings.initialSettings.zoneDefaults.multiProvider).toEqual(
          settings.zoneDefaults.multiProvider,
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "pins a zone default and restores the pre-management value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();
        yield* normalizeBaseline(accountId);

        const settings = yield* stack.deploy(
          Cloudflare.DNS.AccountDnsSettings("AccountDns", {
            zoneDefaults: { multiProvider: true },
          }),
        );

        expect(settings.accountId).toEqual(accountId);
        expect(settings.zoneDefaults.multiProvider).toEqual(true);
        // The pre-management snapshot was captured for restore-on-destroy.
        expect(settings.initialSettings.zoneDefaults.multiProvider).toEqual(
          BASELINE_MULTI_PROVIDER,
        );
        expect(settings.managedKeys).toContain("zoneDefaults.multiProvider");

        // Out-of-band verify via the SDK.
        const live = yield* getSettings(accountId);
        expect(live.zoneDefaults.multiProvider).toEqual(true);

        yield* stack.destroy();

        // Destroy restored the managed field to its pre-management value.
        const restored = yield* getSettings(accountId);
        expect(restored.zoneDefaults.multiProvider).toEqual(
          BASELINE_MULTI_PROVIDER,
        );

        // Re-running destroy is idempotent (nothing left to restore).
        yield* stack.destroy();
        const still = yield* getSettings(accountId);
        expect(still.zoneDefaults.multiProvider).toEqual(
          BASELINE_MULTI_PROVIDER,
        );
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  test.provider(
    "updates in place, unions managedKeys, restores all managed fields",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();
        yield* normalizeBaseline(accountId);

        const initial = yield* stack.deploy(
          Cloudflare.DNS.AccountDnsSettings("AccountDns", {
            zoneDefaults: { multiProvider: true },
          }),
        );
        expect(initial.zoneDefaults.multiProvider).toEqual(true);
        expect(initial.managedKeys).toContain("zoneDefaults.multiProvider");

        // Same singleton patched in place — a second managed field joins;
        // the original snapshot survives the update.
        const updated = yield* stack.deploy(
          Cloudflare.DNS.AccountDnsSettings("AccountDns", {
            zoneDefaults: { multiProvider: true, secondaryOverrides: true },
          }),
        );
        expect(updated.zoneDefaults.multiProvider).toEqual(true);
        expect(updated.zoneDefaults.secondaryOverrides).toEqual(true);
        expect(updated.initialSettings.zoneDefaults.multiProvider).toEqual(
          BASELINE_MULTI_PROVIDER,
        );
        expect(updated.initialSettings.zoneDefaults.secondaryOverrides).toEqual(
          BASELINE_SECONDARY_OVERRIDES,
        );
        expect(updated.managedKeys).toContain("zoneDefaults.multiProvider");
        expect(updated.managedKeys).toContain(
          "zoneDefaults.secondaryOverrides",
        );

        const live = yield* getSettings(accountId);
        expect(live.zoneDefaults.multiProvider).toEqual(true);
        expect(live.zoneDefaults.secondaryOverrides).toEqual(true);

        // Drop `multiProvider` from props — the key stays managed (union
        // across all reconciles) so destroy still restores it.
        const dropped = yield* stack.deploy(
          Cloudflare.DNS.AccountDnsSettings("AccountDns", {
            zoneDefaults: { secondaryOverrides: true },
          }),
        );
        expect(dropped.managedKeys).toContain("zoneDefaults.multiProvider");
        expect(dropped.managedKeys).toContain(
          "zoneDefaults.secondaryOverrides",
        );

        yield* stack.destroy();

        // Both managed fields were restored to their pre-management values.
        const restored = yield* getSettings(accountId);
        expect(restored.zoneDefaults.multiProvider).toEqual(
          BASELINE_MULTI_PROVIDER,
        );
        expect(restored.zoneDefaults.secondaryOverrides).toEqual(
          BASELINE_SECONDARY_OVERRIDES,
        );
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});
