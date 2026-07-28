import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Risk scoring (and its SSF push integrations) is an Enterprise Zero
// Trust feature. On the standard testing account
// `POST /accounts/{id}/zt_risk_scoring/integrations` fails with HTTP 403
// code 3314 "Forbidden" — surfaced as the typed `Forbidden` error. The
// lifecycle test is gated behind an entitled account (plus a real Okta
// tenant) supplied via env; the probe test always runs and pins the
// typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_RISK_SCORING;

test.provider.skipIf(entitled)(
  "unentitled accounts surface the typed Forbidden error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const error = yield* zeroTrust
        .createRiskScoringIntegration({
          accountId,
          integrationType: "Okta",
          tenantUrl: "https://example.okta.com",
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!entitled)(
  "create, toggle active in place, and destroy a risk scoring integration",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const tenantUrl = process.env.CLOUDFLARE_TEST_OKTA_TENANT_URL!;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.RiskScoring.Integration("OktaSsf", {
            tenantUrl,
          });
        }),
      );

      expect(created.integrationId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.tenantUrl).toEqual(tenantUrl);
      expect(created.active).toEqual(true);
      expect(created.wellKnownUrl).toBeTruthy();

      const live = yield* zeroTrust.getRiskScoringIntegration({
        accountId,
        integrationId: created.integrationId,
      });
      expect(live.id).toEqual(created.integrationId);

      // Pausing exports converges in place — same integration id.
      const paused = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.RiskScoring.Integration("OktaSsf", {
            tenantUrl,
            active: false,
          });
        }),
      );
      expect(paused.integrationId).toEqual(created.integrationId);
      expect(paused.active).toEqual(false);

      yield* stack.destroy();

      const gone = yield* zeroTrust
        .getRiskScoringIntegration({
          accountId,
          integrationId: created.integrationId,
        })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("RiskScoringIntegrationNotFound");
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Read-only list assertion. Always runs: on an unentitled account the
// account-scoped list route 403s and `list()` returns [] (Forbidden is
// caught typed); on an entitled account it returns the live integrations
// in the exact `read` Attributes shape. Either way the result is a
// well-typed array.
test.provider(
  "list enumerates risk scoring integrations",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.RiskScoring.Integration,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const item of all) {
        expect(typeof item.integrationId).toBe("string");
        expect(typeof item.accountId).toBe("string");
        expect(item.integrationType).toBe("Okta");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Entitled-account variant: deploy an integration and assert `list()`
// surfaces it (presence in the exhaustively-paginated result).
test.provider.skipIf(!entitled)(
  "list includes a freshly deployed integration",
  (stack) =>
    Effect.gen(function* () {
      const tenantUrl = process.env.CLOUDFLARE_TEST_OKTA_TENANT_URL!;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.RiskScoring.Integration("OktaSsf", {
            tenantUrl,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.RiskScoring.Integration,
      );
      const all = yield* provider.list();

      expect(all.some((x) => x.integrationId === deployed.integrationId)).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
