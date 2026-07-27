import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Custom detections are plan-gated — the standard testing zone has a zero
// custom-detection quota, so any create fails with the typed
// `DetectionQuotaExceeded` error ("exceeded the maximum number of rules:
// 1 out of 0"). Deploying a detection to assert presence in `list()` is
// only feasible on an entitled zone supplied via env; otherwise the test
// runs read-only and asserts a well-typed (possibly empty) result.
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

describe.sequential("LeakedCredentialDetection", () => {
  // Canonical `list()` test (zone-scoped collection): there is no account-wide
  // enumeration API for custom detections, so `list()` fans out over every
  // zone via `listAllZones` and exhaustively paginates the per-zone list,
  // skipping zones whose LCC toggle is off (typed
  // `LeakedCredentialChecksDisabled`) or that 403 (`Forbidden`).
  //
  // On the standard testing account no zone has detections (quota is zero),
  // so the result is a well-typed empty array. When an entitled zone is
  // supplied, deploy a detection and assert it appears in the result.
  test.provider("list enumerates custom detections across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection,
      );

      if (detectionZoneId) {
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
                  zoneId: detectionZoneId,
                  enabled: true,
                },
              );
            return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection(
              "ListDetection",
              {
                zoneId: check.zoneId,
                username: usernameExpr,
                password: passwordExpr,
              },
            );
          }),
        );

        const all = yield* provider.list();
        expect(all.some((d) => d.detectionId === detection.detectionId)).toBe(
          true,
        );
      } else {
        // Read-only assertion: the result is a well-typed array (empty on the
        // unentitled standard account). `zoneId` is resolved to prove the
        // standing test zone exists in the enumeration scope.
        expect(zoneId).toBeTruthy();
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
