import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/cloudflare/logs";
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

// Logpull (and its retention flag) is an Enterprise-only feature. On the
// standard testing account every `/logs/control/retention/flag` call fails
// with Cloudflare error code 10000 ("Unauthorized"), surfaced as the typed
// `LogsControlNotAuthorized` error. The full lifecycle test below is gated
// behind an entitled zone supplied via env.
const entitled = !!process.env.CLOUDFLARE_TEST_LOGS_CONTROL;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union via patches) on out-of-band calls.
const getFlag = (zoneId: string) =>
  logs.getControlRetention({ zoneId }).pipe(
    Effect.map((r) => r.flag ?? false),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const setBaseline = (zoneId: string, flag: boolean) =>
  logs.createControlRetention({ zoneId, flag }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider.skipIf(entitled)(
  "surfaces the typed LogsControlNotAuthorized error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The testing zone has no Logpull entitlement — both reads and
      // writes must fail with the typed authorization tag (Cloudflare
      // error code 10000).
      const readError = yield* logs
        .getControlRetention({ zoneId })
        .pipe(Effect.flip);
      expect(readError._tag).toEqual("LogsControlNotAuthorized");

      const writeError = yield* logs
        .createControlRetention({ zoneId, flag: true })
        .pipe(Effect.flip);
      expect(writeError._tag).toEqual("LogsControlNotAuthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitled)(
  "pins the retention flag, updates in place, and restores on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      // Known baseline: retention disabled.
      yield* setBaseline(zoneId, false);

      const created = yield* stack.deploy(
        Cloudflare.LogsControl.LogsRetentionFlag("Retention", {
          zoneId,
          flag: true,
        }),
      );
      expect(created.zoneId).toEqual(zoneId);
      expect(created.flag).toEqual(true);
      // The pre-management value was captured for restore-on-destroy.
      expect(created.initialFlag).toEqual(false);

      const live = yield* getFlag(zoneId);
      expect(live).toEqual(true);

      // In-place update back to false — the captured initial value
      // survives the update.
      const updated = yield* stack.deploy(
        Cloudflare.LogsControl.LogsRetentionFlag("Retention", {
          zoneId,
          flag: false,
        }),
      );
      expect(updated.flag).toEqual(false);
      expect(updated.initialFlag).toEqual(false);

      const liveUpdated = yield* getFlag(zoneId);
      expect(liveUpdated).toEqual(false);

      // Flip it on again so destroy has something to restore.
      yield* stack.deploy(
        Cloudflare.LogsControl.LogsRetentionFlag("Retention", {
          zoneId,
          flag: true,
        }),
      );

      yield* stack.destroy();

      // Destroy restored the value the flag had before we managed it.
      const restored = yield* getFlag(zoneId);
      expect(restored).toEqual(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped singleton): there is no account-wide
// API for this per-zone flag, so `list()` enumerates every zone via
// `listAllZones` and reads the singleton in each. Logpull is Enterprise-only,
// so on an unentitled account every per-zone read fails with the typed
// `LogsControlNotAuthorized` (code 10000) and `list()` skips it — yielding an
// array (typically empty) rather than throwing. This ungated case asserts that
// the typed-skip path keeps `list()` total; the entitled case below asserts
// the standing test zone is actually enumerated.
test.provider("list enumerates the retention flag across all zones", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(
      Cloudflare.LogsControl.LogsRetentionFlag,
    );
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    // `stack` is unused here (the singleton always exists on every zone),
    // but keep the destroy bookend so the harness state stays clean.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(!entitled)(
  "list contains the entitled test zone's retention flag",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.LogsControl.LogsRetentionFlag,
      );
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((f) => f.zoneId === zoneId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
