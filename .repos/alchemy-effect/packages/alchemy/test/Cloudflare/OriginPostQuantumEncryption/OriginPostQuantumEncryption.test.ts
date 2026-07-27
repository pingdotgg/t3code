import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as pqe from "@distilled.cloud/cloudflare/origin-post-quantum-encryption";
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
// each operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSetting = (zoneId: string) =>
  pqe.getOriginPostQuantumEncryption({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the setting to a known baseline so each run starts from the
// same cloud state regardless of what a previous (possibly interrupted)
// run left behind. Cloudflare's documented default is "supported".
const setBaseline = (
  zoneId: string,
  value: Cloudflare.OriginPostQuantumEncryption.Value,
) =>
  pqe.putOriginPostQuantumEncryption({ zoneId, value }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("OriginPostQuantumEncryption", () => {
  test.provider(
    "pins the setting and restores the original value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Known baseline: Cloudflare's default is "supported".
        yield* setBaseline(zoneId, "supported");

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.OriginPostQuantumEncryption.OriginPostQuantumEncryption(
              "OriginPqe",
              {
                zoneId,
                value: "preferred",
              },
            );
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.value).toEqual("preferred");
        // The pre-management value was captured for restore-on-destroy.
        expect(setting.initialValue).toEqual("supported");
        expect(setting.editable).toEqual(true);

        const live = yield* getSetting(zoneId);
        expect(live.value).toEqual("preferred");

        yield* stack.destroy();

        // Destroy restored the value the setting had before we managed it.
        const restored = yield* getSetting(zoneId);
        expect(restored.value).toEqual("supported");
      }).pipe(logLevel),
  );

  test.provider(
    "updates the value in place and keeps the captured initial value",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Start from a non-default baseline so capture-and-restore is
        // observable: destroy must restore "off", not the documented default.
        yield* setBaseline(zoneId, "off");

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.OriginPostQuantumEncryption.OriginPostQuantumEncryption(
              "OriginPqe",
              {
                zoneId,
                value: "preferred",
              },
            );
          }),
        );

        expect(initial.value).toEqual("preferred");
        expect(initial.initialValue).toEqual("off");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.OriginPostQuantumEncryption.OriginPostQuantumEncryption(
              "OriginPqe",
              {
                zoneId,
                value: "supported",
              },
            );
          }),
        );

        // Same singleton updated in place; the original value survives the
        // update so destroy still restores the pre-management state.
        expect(updated.value).toEqual("supported");
        expect(updated.initialValue).toEqual("off");

        const live = yield* getSetting(zoneId);
        expect(live.value).toEqual("supported");

        yield* stack.destroy();

        // Restored to the captured pre-management value, not the default.
        const restored = yield* getSetting(zoneId);
        expect(restored.value).toEqual("off");

        // Leave the zone on Cloudflare's documented default for other tests.
        yield* setBaseline(zoneId, "supported");
      }).pipe(logLevel),
  );

  test.provider(
    "no-op redeploy converges without changing the setting",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId, "supported");

        const deploy = stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.OriginPostQuantumEncryption.OriginPostQuantumEncryption(
              "OriginPqe",
              {
                zoneId,
                value: "off",
              },
            );
          }),
        );

        const first = yield* deploy;
        expect(first.value).toEqual("off");
        expect(first.initialValue).toEqual("supported");

        // Redeploy with identical props — reconcile observes "off" already
        // live and skips the PUT; attributes stay stable.
        const second = yield* deploy;
        expect(second.value).toEqual("off");
        expect(second.initialValue).toEqual("supported");

        const live = yield* getSetting(zoneId);
        expect(live.value).toEqual("off");

        yield* stack.destroy();

        const restored = yield* getSetting(zoneId);
        expect(restored.value).toEqual("supported");
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Assert the result is
  // non-empty and contains the standing test zone.
  test.provider("list enumerates the setting across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.OriginPostQuantumEncryption.OriginPostQuantumEncryption,
      );
      // The freshly-minted scoped token propagates eventually-consistently, so
      // the account-wide enumeration intermittently 403s (`Forbidden`) or 401s
      // (`Unauthorized`). Both are transient here — ride out the blip like
      // every other out-of-band call in this suite.
      const all = yield* provider.list().pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden" || e._tag === "Unauthorized",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
      );

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
