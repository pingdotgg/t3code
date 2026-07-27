import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
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
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
// Ride out the blips on the test's own out-of-band calls by retrying the
// typed `Forbidden` error (part of each email-routing operation's error union
// via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getEmailRouting = (zoneId: string) =>
  emailRouting.getEmailRouting({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const setEnabled = (zoneId: string, enabled: boolean) =>
  (enabled
    ? emailRouting.enableEmailRouting({ zoneId, body: {} })
    : emailRouting.disableEmailRouting({ zoneId, body: {} })
  ).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("EmailRouting", () => {
  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for these per-zone settings, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Assert the result is
  // non-empty and contains the standing test zone. Capture-and-restore the
  // zone's `enabled` state so the run leaves no residue.
  test.provider("list enumerates email routing across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // Capture the pre-test enabled state to restore at the end.
      const before = yield* getEmailRouting(zoneId);

      const provider = yield* Provider.findProvider(Cloudflare.Email.Routing);
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      const entry = all.find((r) => r.zoneId === zoneId);
      expect(entry).toBeDefined();
      expect(entry!.name).toEqual(zoneName);

      // Restore the captured state.
      yield* setEnabled(zoneId, before.enabled);

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
