import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as mcn from "@distilled.cloud/cloudflare/magic-cloud-networking";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Magic Cloud Networking is an entitlement-gated add-on (Magic WAN family).
// On the standard testing account every MCN call fails with the typed
// `FeatureNotEnabled` error (HTTP 403, Cloudflare code 1012 "feature not
// enabled"). The full lifecycle test below is gated behind an explicit
// opt-in env flag for entitled accounts; the probe test always runs and
// pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_CLOUD_NETWORKING;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band calls. The retry
// is bounded so an unentitled account fails fast with the typed tag.
const getIntegration = (accountId: string, providerId: string) =>
  mcn.getCloudIntegration({ accountId, providerId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 5,
    }),
  );

// Poll until the integration is gone after destroy. Cloudflare answers GET
// for a missing integration with the typed `CloudIntegrationNotFound` (404).
const expectGone = (accountId: string, providerId: string) =>
  getIntegration(accountId, providerId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "IntegrationNotDeleted" } as const),
    ),
    Effect.catchTag("CloudIntegrationNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "IntegrationNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "unentitled accounts surface the typed FeatureNotEnabled error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const canList = yield* mcn.listCloudIntegrations({ accountId }).pipe(
        Effect.as(true),
        Effect.catchTag("FeatureNotEnabled", () => Effect.succeed(false)),
      );
      if (canList) {
        // Entitled account — the gated lifecycle test covers real behavior.
        yield* Effect.logInfo("account is MCN-entitled; probe test is a no-op");
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* mcn
        .listCloudIntegrations({ accountId })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("FeatureNotEnabled");

      const createError = yield* mcn
        .createCloudIntegration({
          accountId,
          cloudType: "AWS",
          friendlyName: "alchemy-mcn-probe",
        })
        .pipe(Effect.flip);
      expect(createError._tag).toEqual("FeatureNotEnabled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("list returns a well-typed array of integrations", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.MagicCloudNetworking.CloudIntegration,
    );
    const all = yield* provider.list();

    // On an unentitled account `list()` catches the typed `FeatureNotEnabled`
    // tag and yields `[]`; on an entitled account it enumerates every
    // integration. Either way the result is the full Attributes array.
    expect(Array.isArray(all)).toBe(true);
    for (const item of all) {
      expect(typeof item.integrationId).toBe("string");
      expect(typeof item.accountId).toBe("string");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(!entitled)(
  "list enumerates the deployed integration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CloudIntegration("ListIntegration", {
          cloudType: "AWS",
          friendlyName: "alchemy-mcn-cloud-integration-list",
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicCloudNetworking.CloudIntegration,
      );
      const all = yield* provider.list();

      expect(all.some((x) => x.integrationId === deployed.integrationId)).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "registers an AWS integration, updates it in place, and destroys it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const integration = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CloudIntegration("Aws", {
          cloudType: "AWS",
          friendlyName: "alchemy-mcn-cloud-integration",
          description: "alchemy cloud integration test",
        }),
      );

      expect(integration.integrationId).toBeDefined();
      expect(integration.accountId).toEqual(accountId);
      expect(integration.cloudType).toEqual("AWS");
      expect(integration.friendlyName).toEqual("alchemy-mcn-cloud-integration");
      // No credentials are wired yet — the integration is pending setup.
      expect(integration.lifecycleState).toEqual("PENDING_SETUP");

      // Out-of-band verification via the distilled API.
      const live = yield* getIntegration(accountId, integration.integrationId);
      expect(live.friendlyName).toEqual("alchemy-mcn-cloud-integration");
      expect(live.cloudType).toEqual("AWS");

      // Update mutable props in place — same integrationId.
      const updated = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CloudIntegration("Aws", {
          cloudType: "AWS",
          friendlyName: "alchemy-mcn-cloud-integration-v2",
          description: "alchemy cloud integration test v2",
        }),
      );

      expect(updated.integrationId).toEqual(integration.integrationId);
      expect(updated.friendlyName).toEqual("alchemy-mcn-cloud-integration-v2");
      expect(updated.description).toEqual("alchemy cloud integration test v2");

      const liveUpdated = yield* getIntegration(
        accountId,
        integration.integrationId,
      );
      expect(liveUpdated.friendlyName).toEqual(
        "alchemy-mcn-cloud-integration-v2",
      );

      yield* stack.destroy();

      yield* expectGone(accountId, integration.integrationId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "replaces the integration when cloudType changes",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CloudIntegration("ReplaceIntegration", {
          cloudType: "AWS",
          friendlyName: "alchemy-mcn-cloud-integration-replace",
        }),
      );

      // cloudType is the provider identity — changing it must produce a
      // brand-new integration (new integrationId).
      const replaced = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CloudIntegration("ReplaceIntegration", {
          cloudType: "GOOGLE",
          friendlyName: "alchemy-mcn-cloud-integration-replace",
        }),
      );

      expect(replaced.integrationId).not.toEqual(initial.integrationId);
      expect(replaced.cloudType).toEqual("GOOGLE");

      yield* expectGone(accountId, initial.integrationId);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.integrationId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
