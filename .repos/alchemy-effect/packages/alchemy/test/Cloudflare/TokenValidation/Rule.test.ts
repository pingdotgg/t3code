import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { JWKS_KEY_1 } from "./fixtures/jwks.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// JWT validation (API Shield) is entitlement-gated. On the standard testing
// account every token_validation call fails with the typed
// `TokenValidationNotEntitled` error (Cloudflare code 10403), so the deploy
// portion of the list test is gated behind an entitled zone id supplied via
// env. The read-only list assertion below always runs: `list()` fans out over
// every zone and skips unentitled/forbidden zones, returning a well-typed `[]`.
const entitledZoneId = process.env.CLOUDFLARE_TEST_TOKEN_VALIDATION_ZONE_ID;

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

// Read-only: always safe. On an unentitled account every per-zone listRules
// rejects with the typed `TokenValidationNotEntitled` (or `Forbidden`) tag,
// which `list()` catches per zone -> the aggregate result is a well-typed `[]`.
test.provider(
  "list returns a typed array of token validation rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.TokenValidation.Rule,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Each element is the full `read` Attributes shape.
      for (const rule of all) {
        expect(typeof rule.ruleId).toBe("string");
        expect(typeof rule.zoneId).toBe("string");
        expect(typeof rule.action).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Full lifecycle: gated on an entitled zone. Deploy a rule, then assert it is
// present in the exhaustively-paginated `list()` output.
test.provider.skipIf(!entitledZoneId)(
  "list enumerates the deployed token validation rule",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const config = yield* Cloudflare.TokenValidation.TokenConfiguration(
            "JwtConfig",
            {
              zoneId,
              description: "list-test",
              tokenSources: ['http.request.headers["authorization"][0]'],
              keys: [JWKS_KEY_1],
            },
          );
          return yield* Cloudflare.TokenValidation.Rule("JwtRule", {
            zoneId,
            action: "log",
            expression: Output.interpolate`is_jwt_valid("${config.configId}")`,
            selector: { include: [{ host: [zoneName] }] },
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.TokenValidation.Rule,
      );
      const all = yield* provider.list();

      const found = all.find(
        (r) => r.zoneId === zoneId && r.ruleId === deployed.ruleId,
      );
      expect(found).toBeDefined();
      expect(found?.action).toEqual("log");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
