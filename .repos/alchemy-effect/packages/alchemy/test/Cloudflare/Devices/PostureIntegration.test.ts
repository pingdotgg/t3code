import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Device posture integrations require a reachable third-party tenant —
// Cloudflare validates the configured credentials against the live
// provider API at create time. Without one, `POST
// /accounts/{id}/devices/posture/integration` fails with HTTP 400 code
// 2046 "invalid posture integration request: invalid credentials: ..."
// — surfaced as the typed `InvalidPostureIntegrationConfig` error
// (observed: a custom_s2s probe against https://example.com/posture with
// a real Access service token returns exactly this tag because the
// endpoint answers 405 instead of a posture payload). The lifecycle test
// is gated behind a real provider supplied via env; the probe test
// always runs and pins the typed tag.
const external = !!process.env.CLOUDFLARE_TEST_POSTURE_INTEGRATION;

test.provider.skipIf(external)(
  "creates without a real provider surface the typed InvalidPostureIntegrationConfig error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // A real Access service token isolates the probe to the third-party
      // validation step (dummy Access creds would fail earlier).
      const { token } = yield* stack.deploy(
        Effect.gen(function* () {
          const token = yield* Cloudflare.Access.ServiceToken("ProbeToken", {
            name: "alchemy-test-posture-probe-token",
          });
          return { token };
        }),
      );
      expect(token.clientId).toBeDefined();
      expect(token.clientSecret).toBeDefined();

      const error = yield* zeroTrust
        .createDevicePostureIntegration({
          accountId,
          name: "alchemy-posture-probe",
          type: "custom_s2s",
          interval: "10m",
          config: {
            apiUrl: "https://example.com/posture",
            clientSecret: "dummy-secret",
            accessClientId: token.clientId,
            accessClientSecret: Redacted.value(token.clientSecret!),
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidPostureIntegrationConfig");
      if (error._tag === "InvalidPostureIntegrationConfig") {
        expect(error.message).toContain("invalid posture integration request");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!external)(
  "create, update in place, and destroy a posture integration",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Requires a reachable custom_s2s endpoint configured via env.
      const apiUrl = process.env.CLOUDFLARE_TEST_POSTURE_API_URL!;
      const secret = process.env.CLOUDFLARE_TEST_POSTURE_SECRET!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const token = yield* Cloudflare.Access.ServiceToken("S2sToken", {
            name: "alchemy-test-posture-s2s-token",
          });
          const integration =
            yield* Cloudflare.Devices.DevicePostureIntegration("Custom", {
              name: "alchemy-test-posture-integration",
              type: "custom_s2s",
              interval: "10m",
              config: {
                apiUrl,
                clientSecret: Redacted.make(secret),
                accessClientId: token.clientId,
                accessClientSecret: token.clientSecret!,
              },
            });
          return { token, integration };
        }),
      );

      expect(created.integration.integrationId).toBeDefined();
      expect(created.integration.accountId).toEqual(accountId);
      expect(created.integration.interval).toEqual("10m");

      const live = yield* zeroTrust.getDevicePostureIntegration({
        accountId,
        integrationId: created.integration.integrationId,
      });
      expect(live.id).toEqual(created.integration.integrationId);

      yield* stack.destroy();

      const gone = yield* zeroTrust
        .getDevicePostureIntegration({
          accountId,
          integrationId: created.integration.integrationId,
        })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("DevicePostureIntegrationNotFound");
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Canonical `list()` test (account collection): `list()` enumerates every
// posture integration in the ambient account via the distilled paginated
// list op and returns the exact `read` Attributes shape. This read-only
// assertion always runs — without an entitled account / external provider
// the account simply has no integrations, so `list()` returns a well-typed
// empty array (Zero Trust `Forbidden` is mapped to `[]`).
test.provider(
  "list enumerates posture integrations in the account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Devices.DevicePostureIntegration,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const item of all) {
        expect(typeof item.integrationId).toBe("string");
        expect(typeof item.accountId).toBe("string");
        expect(typeof item.type).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// When an entitled account + reachable external provider is supplied via
// env, deploy a real integration and assert `list()` includes it.
test.provider.skipIf(!external)(
  "list includes a deployed posture integration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const apiUrl = process.env.CLOUDFLARE_TEST_POSTURE_API_URL!;
      const secret = process.env.CLOUDFLARE_TEST_POSTURE_SECRET!;

      const { integration } = yield* stack.deploy(
        Effect.gen(function* () {
          const token = yield* Cloudflare.Access.ServiceToken("ListS2sToken", {
            name: "alchemy-test-posture-list-token",
          });
          const integration =
            yield* Cloudflare.Devices.DevicePostureIntegration("ListCustom", {
              name: "alchemy-test-posture-list-integration",
              type: "custom_s2s",
              interval: "10m",
              config: {
                apiUrl,
                clientSecret: Redacted.make(secret),
                accessClientId: token.clientId,
                accessClientSecret: token.clientSecret!,
              },
            });
          return { integration };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Devices.DevicePostureIntegration,
      );
      const all = yield* provider.list();

      expect(
        all.some((i) => i.integrationId === integration.integrationId),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
