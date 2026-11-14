import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// This file stays read-only on the standing test zone: the detection
// lifecycle (including a `list()` presence assertion) runs in
// LeakedCredentialCheck.test.ts, serialized with the other tests that flip
// the same zone-level LCC toggle. Files run concurrently, so deploying a
// detection here would race those toggle mutations. Supply
// CLOUDFLARE_TEST_LCC_DETECTION_ZONE_ID=<another zone> to deploy here.
const detectionZoneId = process.env.CLOUDFLARE_TEST_LCC_DETECTION_ZONE_ID;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

describe.sequential(
  "LeakedCredentialDetection",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:leakedcredentialcheck",
      "provider:cloudflare:zone",
      "live",
    ],
  },
  () => {
    // Canonical `list()` test (zone-scoped collection): there is no account-wide
    // enumeration API for custom detections, so `list()` fans out over every
    // zone via `listAllZones` and exhaustively paginates the per-zone list,
    // skipping zones whose LCC toggle is off (typed
    // `LeakedCredentialChecksDisabled`) or that 403 (`Forbidden`).
    //
    // Without an override zone the assertion is read-only (a well-typed
    // array). With one, deploy a detection and assert it appears.
    test.provider("list enumerates custom detections across all zones", (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        const provider = yield* Provider.findProvider(
          Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection,
        );

        if (detectionZoneId) {
          const usernameExpr = 'lookup_json_string(http.request.body.raw, "user")';
          const passwordExpr = 'lookup_json_string(http.request.body.raw, "pass")';

          const detection = yield* stack.deploy(
            Effect.gen(function* () {
              const check = yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
                zoneId: detectionZoneId,
                enabled: true,
              });
              return yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection(
                "ListDetection",
                { zoneId: check.zoneId, username: usernameExpr, password: passwordExpr },
              );
            }),
          );

          const all = yield* provider.list();
          expect(all.some((d) => d.detectionId === detection.detectionId)).toBe(true);
        } else {
          // Read-only assertion: the result is a well-typed array (empty on the
          // standing zone between runs). `zoneId` is resolved to prove the
          // standing test zone exists in the enumeration scope.
          expect(zoneId).toBeTruthy();
          const all = yield* provider.list();
          expect(Array.isArray(all)).toBe(true);
        }

        yield* stack.destroy();
      }).pipe(logLevel),
    );
  },
);
