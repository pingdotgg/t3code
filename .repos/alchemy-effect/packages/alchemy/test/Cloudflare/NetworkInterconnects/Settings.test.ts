import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cni from "@distilled.cloud/cloudflare/network-interconnects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
// Ride out the blips by retrying the typed `Forbidden` error (part of each
// CNI setting operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSetting = (accountId: string) =>
  cni.getSetting({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the singleton to a known baseline so each run starts from the
// same cloud state regardless of what a previous (possibly interrupted)
// run left behind. 13335 is Cloudflare's own ASN — the account default.
const baselineAsn = 13335;

const setBaseline = (accountId: string) =>
  cni.putSetting({ accountId, defaultAsn: baselineAsn }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "pins the default ASN, updates in place, and restores the original on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // CNI is entitlement-gated — on accounts without the Network
      // Interconnect feature every call fails with the typed `Forbidden`
      // error even after the token-propagation retries. Skip the
      // lifecycle assertions on such accounts.
      const probe = yield* getSetting(accountId).pipe(
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );
      if (probe === undefined) {
        yield* Effect.logWarning(
          "Skipping: account lacks the Cloudflare Network Interconnect entitlement (Forbidden).",
        );
        return;
      }

      yield* setBaseline(accountId);

      const settings = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.NetworkInterconnects.NetworkInterconnectSettings(
            "CniSettings",
            {
              defaultAsn: 65000,
            },
          );
        }),
      );

      expect(settings.accountId).toEqual(accountId);
      expect(settings.defaultAsn).toEqual(65000);
      // The pre-management value was captured for restore-on-destroy.
      expect(settings.initialDefaultAsn).toEqual(baselineAsn);

      // Out-of-band verification via the distilled API.
      const live = yield* getSetting(accountId);
      expect(live.defaultAsn).toEqual(65000);

      // Update in place — same singleton, initialDefaultAsn survives.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.NetworkInterconnects.NetworkInterconnectSettings(
            "CniSettings",
            {
              defaultAsn: 64999,
            },
          );
        }),
      );
      expect(updated.defaultAsn).toEqual(64999);
      expect(updated.initialDefaultAsn).toEqual(baselineAsn);

      const liveUpdated = yield* getSetting(accountId);
      expect(liveUpdated.defaultAsn).toEqual(64999);

      yield* stack.destroy();

      // Destroy restored the value the singleton had before we managed it.
      const restored = yield* getSetting(accountId);
      expect(restored.defaultAsn).toEqual(baselineAsn);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account singleton): there is no enumeration API
// for the CNI settings object, so `list()` reads the single
// `/accounts/{account_id}/cni/settings` and returns a one-element array.
// CNI is enterprise-gated — on accounts without the entitlement the route
// rejects with the typed `Forbidden` error, which `list()` maps to `[]`
// ("unset"). The read-only assertions below hold in both cases; the
// entitled-account content assertion is gated on a non-empty result.
test.provider(
  "list enumerates the CNI settings singleton",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.NetworkInterconnects.NetworkInterconnectSettings,
      );
      const all = yield* provider.list();

      // Always a well-typed array (empty when the account lacks the
      // entitlement, one element when CNI settings are present).
      expect(Array.isArray(all)).toBe(true);
      expect(all.length).toBeLessThanOrEqual(1);

      if (all.length === 0) {
        yield* Effect.logWarning(
          "list() returned []: account lacks the Cloudflare Network Interconnect entitlement (Forbidden).",
        );
      } else {
        const [settings] = all;
        expect(settings.accountId).toEqual(accountId);
        expect(typeof settings.defaultAsn).toBe("number");
        expect(settings.initialDefaultAsn).toEqual(settings.defaultAsn);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
