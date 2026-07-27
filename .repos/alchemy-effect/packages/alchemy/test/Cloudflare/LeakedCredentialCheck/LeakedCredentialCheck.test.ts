import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as lcc from "@distilled.cloud/cloudflare/leaked-credential-checks";
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

// Custom detection locations are plan-gated — on the testing account's free
// zone the quota is zero and every create fails with the typed
// `DetectionQuotaExceeded` error ("exceeded the maximum number of rules:
// 1 out of 0"). The full detection lifecycle test below is gated behind an
// entitled zone id supplied via env.
const detectionZoneId = process.env.CLOUDFLARE_TEST_LCC_DETECTION_ZONE_ID;

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
// typed `Forbidden` error (part of each operation's error union via
// distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCheck = (zoneId: string) =>
  lcc.getLeakedCredentialCheck({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const setBaseline = (zoneId: string, enabled: boolean) =>
  lcc.createLeakedCredentialCheck({ zoneId, enabled }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases mutate the same zone-level Leaked Credential Check singleton; run them serially so they don't corrupt each other's captured `initialEnabled` under the global concurrent test config.
describe.sequential("LeakedCredentialCheck", () => {
  test.provider(
    "enables leaked credential checks and restores the baseline on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Known baseline: the check defaults to disabled.
        yield* setBaseline(zoneId, false);

        const check = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck(
              "Lcc",
              {
                zoneId,
              },
            );
          }),
        );

        expect(check.zoneId).toEqual(zoneId);
        expect(check.enabled).toEqual(true);
        // The pre-management value was captured for restore-on-destroy.
        expect(check.initialEnabled).toEqual(false);

        // Out-of-band verification via the distilled API.
        const live = yield* getCheck(zoneId);
        expect(live.enabled).toEqual(true);

        // Update in place — same singleton, initialEnabled survives.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck(
              "Lcc",
              {
                zoneId,
                enabled: false,
              },
            );
          }),
        );
        expect(updated.enabled).toEqual(false);
        expect(updated.initialEnabled).toEqual(false);

        const disabled = yield* getCheck(zoneId);
        expect(disabled.enabled).toEqual(false);

        // Flip back on so destroy has something to restore.
        const reEnabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck(
              "Lcc",
              {
                zoneId,
                enabled: true,
              },
            );
          }),
        );
        expect(reEnabled.enabled).toEqual(true);
        expect(reEnabled.initialEnabled).toEqual(false);

        yield* stack.destroy();

        // Destroy restored the value the check had before we managed it.
        const restored = yield* getCheck(zoneId);
        expect(restored.enabled).toEqual(false);
      }).pipe(logLevel),
  );

  test.provider(
    "surfaces the typed DetectionQuotaExceeded error on unentitled zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // Detection operations require the zone toggle to be on.
        yield* setBaseline(zoneId, true);

        // The standard testing zone has a zero custom-detection quota — the
        // distilled call must fail with the typed quota tag.
        const error = yield* lcc
          .createDetection({
            zoneId,
            username: 'lookup_json_string(http.request.body.raw, "user")',
            password: 'lookup_json_string(http.request.body.raw, "secret")',
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: forbiddenRetrySchedule,
              times: 8,
            }),
            Effect.flip,
          );
        expect(error._tag).toEqual("DetectionQuotaExceeded");

        // Restore the zone's baseline (toggle off).
        yield* setBaseline(zoneId, false);

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Assert the result is
  // non-empty and contains the standing test zone.
  test.provider("list enumerates the check across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck,
      );
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookends so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );

  // Requires a zone with a non-zero custom-detection quota (plan-gated) — the standard
  // zone fails with the typed DetectionQuotaExceeded. Unlock with CLOUDFLARE_TEST_LCC_DETECTION_ZONE_ID=<zone id>.
  test.provider.skipIf(!detectionZoneId)(
    "creates, updates, and destroys a custom detection",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = detectionZoneId!;

        yield* stack.destroy();

        const usernameExpr =
          'lookup_json_string(http.request.body.raw, "user")';
        const passwordExpr =
          'lookup_json_string(http.request.body.raw, "pass")';

        const detection = yield* stack.deploy(
          Effect.gen(function* () {
            const check =
              yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck(
                "Lcc",
                {
                  zoneId,
                  enabled: true,
                },
              );
            return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection(
              "Det",
              {
                // Depend on the check so the toggle deploys first.
                zoneId: check.zoneId,
                username: usernameExpr,
                password: passwordExpr,
              },
            );
          }),
        );

        expect(detection.detectionId).not.toEqual("");
        expect(detection.zoneId).toEqual(zoneId);
        expect(detection.username).toEqual(usernameExpr);
        expect(detection.password).toEqual(passwordExpr);

        // Out-of-band verification via the distilled API.
        const live = yield* lcc.getDetection({
          zoneId,
          detectionId: detection.detectionId,
        });
        expect(live.username).toEqual(usernameExpr);

        // In-place update — the PUT keeps the same detection id.
        const newPasswordExpr =
          'lookup_json_string(http.request.body.raw, "secret")';
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const check =
              yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck(
                "Lcc",
                {
                  zoneId,
                  enabled: true,
                },
              );
            return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection(
              "Det",
              {
                zoneId: check.zoneId,
                username: usernameExpr,
                password: newPasswordExpr,
              },
            );
          }),
        );
        expect(updated.detectionId).toEqual(detection.detectionId);
        expect(updated.password).toEqual(newPasswordExpr);

        yield* stack.destroy();

        // The detection is gone — the typed not-found tag proves it.
        const error = yield* lcc
          .getDetection({ zoneId, detectionId: detection.detectionId })
          .pipe(Effect.flip);
        expect([
          "DetectionNotFound",
          "LeakedCredentialChecksDisabled",
        ]).toContain(error._tag);
      }).pipe(logLevel),
  );
});
