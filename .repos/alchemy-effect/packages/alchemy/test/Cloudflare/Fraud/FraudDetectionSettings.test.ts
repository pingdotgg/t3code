import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as fraud from "@distilled.cloud/cloudflare/fraud";
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

// Fraud Detection (User Profiles) is a beta, subscription-gated product.
// On the standard testing zone any meaningful PUT (writing `user_profiles`,
// non-empty `username_expressions`, or `authentication_settings`) fails with
// Cloudflare error code 10400 — "A fraud detection subscription is required"
// — surfaced as the typed `FraudDetectionNotEntitled` error. The full
// write lifecycle test below is gated behind an entitled zone via env.
const entitled = !!process.env.CLOUDFLARE_TEST_FRAUD_DETECTION;

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
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getSettings = (zoneId: string) =>
  fraud.getFraud({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// Both cases mutate the same zone-level fraud-detection settings singleton; run them serially so they don't corrupt each other's captured baseline under the global concurrent test config.
describe.sequential("DetectionSettings", () => {
  test.provider(
    "adopts the zone singleton without writing and restores nothing on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        const before = yield* getSettings(zoneId);

        // 1. Create — adopt the singleton with no settings set: reconcile
        //    observes but never PUTs.
        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Fraud.DetectionSettings("Fraud", {
              zoneId,
            });
          }),
        );
        expect(adopted.zoneId).toEqual(zoneId);
        // The snapshot captured the pre-management state.
        expect(adopted.initialSettings.userProfiles ?? null).toEqual(
          before.userProfiles ?? null,
        );
        expect(adopted.initialSettings.usernameExpressions ?? null).toEqual(
          before.usernameExpressions ?? null,
        );

        const afterDeploy = yield* getSettings(zoneId);
        expect(afterDeploy.userProfiles ?? null).toEqual(
          before.userProfiles ?? null,
        );
        expect(afterDeploy.usernameExpressions ?? null).toEqual(
          before.usernameExpressions ?? null,
        );

        // 2. In-place update — set `usernameExpressions` to the value the
        //    zone already has: reconcile diffs observed vs desired and
        //    skips the PUT (which would otherwise require a subscription).
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Fraud.DetectionSettings("Fraud", {
              zoneId,
              usernameExpressions: [...(before.usernameExpressions ?? [])],
            });
          }),
        );
        expect(updated.zoneId).toEqual(zoneId);
        expect(updated.usernameExpressions ?? []).toEqual(
          before.usernameExpressions ?? [],
        );
        // The initial snapshot stays sticky across updates.
        expect(updated.initialSettings.userProfiles ?? null).toEqual(
          before.userProfiles ?? null,
        );

        // 3. Destroy — nothing was written, so nothing is restored and the
        //    live settings are untouched.
        yield* stack.destroy();

        const afterDestroy = yield* getSettings(zoneId);
        expect(afterDestroy.userProfiles ?? null).toEqual(
          before.userProfiles ?? null,
        );
        expect(afterDestroy.usernameExpressions ?? null).toEqual(
          before.usernameExpressions ?? null,
        );
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Unentitlement probe — pins the typed FraudDetectionNotEntitled rejection (code 10400)
  // and skips on entitled zones, where the PUT would succeed and mutate live settings.
  test.provider.skipIf(entitled)(
    "surfaces the typed FraudDetectionNotEntitled error on unentitled zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // Writing `user_profiles` (even "disabled") requires a fraud
        // detection subscription — the distilled PUT must fail with the
        // typed entitlement tag (Cloudflare error code 10400). Reads on the
        // same zone succeed, proving the gate is on writes, not the token.
        const error = yield* fraud
          .putFraud({ zoneId, userProfiles: "disabled" })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: Schedule.exponential("500 millis"),
              times: 8,
            }),
            Effect.flip,
          );
        expect(error._tag).toEqual("FraudDetectionNotEntitled");

        const settings = yield* getSettings(zoneId);
        expect(settings.userProfiles ?? "disabled").toEqual(
          settings.userProfiles ?? "disabled",
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Requires a zone with a Fraud Detection (beta) subscription — unentitled zones fail with
  // the typed FraudDetectionNotEntitled (code 10400). Unlock with CLOUDFLARE_TEST_FRAUD_DETECTION=1.
  test.provider.skipIf(!entitled)(
    "manages fraud detection settings and restores them on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        const original = yield* getSettings(zoneId);

        const expression =
          'lookup_json_string(http.request.body.raw, "username")';

        yield* Effect.gen(function* () {
          // 1. Create — enable user profiles with one username expression.
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Fraud.DetectionSettings("Fraud", {
                zoneId,
                userProfiles: "enabled",
                usernameExpressions: [expression],
              });
            }),
          );
          expect(created.zoneId).toEqual(zoneId);
          expect(created.userProfiles).toEqual("enabled");
          expect(created.usernameExpressions).toEqual([expression]);
          expect(created.initialSettings.userProfiles ?? null).toEqual(
            original.userProfiles ?? null,
          );

          const live1 = yield* getSettings(zoneId);
          expect(live1.userProfiles).toEqual("enabled");
          expect(live1.usernameExpressions).toEqual([expression]);

          // 2. In-place update — add authentication outcome classification;
          //    same singleton (same zoneId), sticky snapshot.
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Fraud.DetectionSettings("Fraud", {
                zoneId,
                userProfiles: "enabled",
                usernameExpressions: [expression],
                authenticationSettings: {
                  successCriteria: { kind: "status_code", statusCodes: [200] },
                  failureCriteria: {
                    kind: "status_code",
                    statusCodes: [401, 403],
                  },
                },
              });
            }),
          );
          expect(updated.authenticationSettings?.successCriteria).toEqual({
            kind: "status_code",
            statusCodes: [200],
          });
          expect(updated.initialSettings.userProfiles ?? null).toEqual(
            original.userProfiles ?? null,
          );

          const live2 = yield* getSettings(zoneId);
          expect(
            live2.authenticationSettings?.successCriteria?.statusCodes,
          ).toEqual([200]);

          // 3. Destroy — the managed fields are restored to the snapshot.
          yield* stack.destroy();

          const after = yield* getSettings(zoneId);
          expect(after.userProfiles ?? null).toEqual(
            original.userProfiles ?? null,
          );
          expect(after.usernameExpressions ?? null).toEqual(
            original.usernameExpressions ?? null,
          );
        }).pipe(
          Effect.ensuring(
            fraud
              .putFraud({
                zoneId,
                userProfiles:
                  original.userProfiles === "enabled" ? "enabled" : "disabled",
                usernameExpressions: [...(original.usernameExpressions ?? [])],
              })
              .pipe(Effect.ignore),
          ),
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. `getFraud` is a read and
  // never trips the entitlement gate (which lives on `putFraud`), so this
  // read-only assertion always runs. Assert the result is non-empty and
  // contains the standing test zone.
  test.provider("list enumerates the settings across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.Fraud.DetectionSettings,
      );
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
