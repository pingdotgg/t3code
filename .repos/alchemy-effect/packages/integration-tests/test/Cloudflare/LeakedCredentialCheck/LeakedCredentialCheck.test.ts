import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as lcc from "@distilled.cloud/cloudflare/leaked-credential-checks";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Custom detection locations are plan-gated, but the standing test zone now
// has a non-zero quota, so the detection lifecycle runs there by default.
// Override the zone with CLOUDFLARE_TEST_LCC_DETECTION_ZONE_ID=<zone id>.
const detectionZoneId = process.env.CLOUDFLARE_TEST_LCC_DETECTION_ZONE_ID;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
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
describe.sequential(
  "LeakedCredentialCheck",
  { tags: ["provider:cloudflare", "provider:cloudflare:leakedcredentialcheck", "live"] },
  () => {
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
              return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
                zoneId,
              });
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
              return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
                zoneId,
                enabled: false,
              });
            }),
          );
          expect(updated.enabled).toEqual(false);
          expect(updated.initialEnabled).toEqual(false);

          const disabled = yield* getCheck(zoneId);
          expect(disabled.enabled).toEqual(false);

          // Flip back on so destroy has something to restore.
          const reEnabled = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
                zoneId,
                enabled: true,
              });
            }),
          );
          expect(reEnabled.enabled).toEqual(true);
          expect(reEnabled.initialEnabled).toEqual(false);

          yield* stack.destroy();

          // Destroy restored the value the check had before we managed it.
          const restored = yield* getCheck(zoneId);
          expect(restored.enabled).toEqual(false);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:zone"] },
    );

    // Canonical `list()` test (zone-scoped singleton): there is no account-wide
    // API for this per-zone setting, so `list()` enumerates every zone via
    // `listAllZones` and reads the singleton in each. Assert the result is
    // non-empty and contains the standing test zone.
    test.provider(
      "list enumerates the check across all zones",
      (stack) =>
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
      { tags: ["provider:cloudflare:zone"] },
    );

    test.provider(
      "creates, updates, and destroys a custom detection",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = detectionZoneId ?? (yield* resolveZoneId);

          yield* stack.destroy();
          // Known baseline: the zone toggle is off before we manage it.
          yield* setBaseline(zoneId, false);

          const usernameExpr = 'lookup_json_string(http.request.body.raw, "user")';
          const passwordExpr = 'lookup_json_string(http.request.body.raw, "pass")';

          const detection = yield* stack.deploy(
            Effect.gen(function* () {
              const check = yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
                zoneId,
                enabled: true,
              });
              return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection("Det", {
                // Depend on the check so the toggle deploys first.
                zoneId: check.zoneId,
                username: usernameExpr,
                password: passwordExpr,
              });
            }),
          );

          expect(detection.detectionId).not.toEqual("");
          expect(detection.zoneId).toEqual(zoneId);
          expect(detection.username).toEqual(usernameExpr);
          expect(detection.password).toEqual(passwordExpr);

          // Out-of-band verification via the distilled API.
          const live = yield* lcc.getDetection({ zoneId, detectionId: detection.detectionId });
          expect(live.username).toEqual(usernameExpr);

          // A second detection with the same expression pair is rejected
          // with the typed duplicate tag (not the catch-all BadRequest).
          const duplicate = yield* lcc
            .createDetection({ zoneId, username: usernameExpr, password: passwordExpr })
            .pipe(Effect.flip);
          expect(duplicate._tag).toEqual("DetectionAlreadyExists");

          // `list()` enumerates the deployed detection.
          const provider = yield* Provider.findProvider(
            Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection,
          );
          const all = yield* provider.list();
          expect(all.some((d) => d.detectionId === detection.detectionId)).toBe(true);

          // In-place update — the PUT keeps the same detection id.
          const newPasswordExpr = 'lookup_json_string(http.request.body.raw, "secret")';
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const check = yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
                zoneId,
                enabled: true,
              });
              return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection("Det", {
                zoneId: check.zoneId,
                username: usernameExpr,
                password: newPasswordExpr,
              });
            }),
          );
          expect(updated.detectionId).toEqual(detection.detectionId);
          expect(updated.password).toEqual(newPasswordExpr);

          yield* stack.destroy();

          // Destroy restored the toggle to its pre-management value (off),
          // which hides detections from the API. Flip it on out-of-band to
          // prove the detection itself was deleted, then restore the baseline.
          const restored = yield* getCheck(zoneId);
          expect(restored.enabled).toEqual(false);
          yield* setBaseline(zoneId, true);
          const error = yield* lcc
            .getDetection({ zoneId, detectionId: detection.detectionId })
            .pipe(Effect.flip);
          expect(error._tag).toEqual("DetectionNotFound");
          const remaining = yield* lcc.listDetections({ zoneId });
          expect(remaining.result ?? []).toEqual([]);
          yield* setBaseline(zoneId, false);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:zone"], timeout: 120_000 },
    );
  },
);
