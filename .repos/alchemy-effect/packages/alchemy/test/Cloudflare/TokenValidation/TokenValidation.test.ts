import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as tokenValidation from "@distilled.cloud/cloudflare/token-validation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { JWKS_KEY_1, JWKS_KEY_2 } from "./fixtures/jwks.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// JWT validation (API Shield) is entitlement-gated — on the standard testing
// account every token_validation call fails with "You are not entitled for
// this service" (code 10403), surfaced as the typed
// `TokenValidationNotEntitled` error. The full lifecycle test below is gated
// behind an entitled zone id supplied via env.
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

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const listConfigurations = (zoneId: string) =>
  tokenValidation.listConfigurations({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const getConfiguration = (zoneId: string, configId: string) =>
  tokenValidation.getConfiguration({ zoneId, configId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const getRule = (zoneId: string, ruleId: string) =>
  tokenValidation.getRule({ zoneId, ruleId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed TokenValidationNotEntitled error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The testing account lacks the API Shield JWT validation
      // entitlement — every distilled call must fail with the typed
      // entitlement tag (never the catch-all
      // `Forbidden`/`UnknownCloudflareError`).
      const listError = yield* listConfigurations(zoneId).pipe(Effect.flip);
      expect(listError._tag).toEqual("TokenValidationNotEntitled");

      const getError = yield* getConfiguration(
        zoneId,
        "00000000-0000-0000-0000-000000000000",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("TokenValidationNotEntitled");

      const ruleError = yield* getRule(
        zoneId,
        "00000000-0000-0000-0000-000000000000",
      ).pipe(Effect.flip);
      expect(ruleError._tag).toEqual("TokenValidationNotEntitled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped collection): configurations live
// inside a zone and the list op is keyed per zone, so `list()` enumerates
// every zone via `listAllZones` and fans out the per-zone list, skipping
// zones that reject with the typed `TokenValidationNotEntitled` / `Forbidden`
// tags. On the unentitled testing account every zone is skipped, so the
// result is an empty array — the assertion is that `list()` resolves to an
// array (proving the typed skip path) rather than throwing. Presence of a
// deployed configuration is asserted only on an entitled account (env-gated).
test.provider(
  "list enumerates configurations across all zones",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.TokenValidation.TokenConfiguration,
      );

      if (!entitledZoneId) {
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        yield* stack.destroy();
        return;
      }

      const zoneId = entitledZoneId;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.TokenValidation.TokenConfiguration(
            "JwtConfigList",
            {
              zoneId,
              tokenSources: ['http.request.headers["authorization"][0]'],
              keys: [JWKS_KEY_1],
            },
          );
        }),
      );

      const all = yield* provider.list();
      expect(all.some((c) => c.configId === deployed.configId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitledZoneId)(
  "configuration + rule lifecycle: create, update in place, rotate keys, destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;

      yield* stack.destroy();

      // -- Create: configuration with one key, rule that logs ------------
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const config = yield* Cloudflare.TokenValidation.TokenConfiguration(
            "JwtConfig",
            {
              zoneId,
              description: "v1",
              tokenSources: ['http.request.headers["authorization"][0]'],
              keys: [JWKS_KEY_1],
            },
          );
          const rule = yield* Cloudflare.TokenValidation.Rule("JwtRule", {
            zoneId,
            description: "v1",
            action: "log",
            expression: Output.interpolate`is_jwt_valid("${config.configId}")`,
            selector: { include: [{ host: [zoneName] }] },
          });
          return { config, rule };
        }),
      );

      expect(created.config.configId).toBeDefined();
      expect(created.config.zoneId).toEqual(zoneId);
      expect(created.config.tokenType).toEqual("JWT");
      expect(created.config.keys.map((k) => k.kid)).toEqual([JWKS_KEY_1.kid]);
      expect(created.rule.ruleId).toBeDefined();
      expect(created.rule.action).toEqual("log");
      expect(created.rule.enabled).toEqual(true);
      expect(created.rule.expression).toContain(created.config.configId);

      // Out-of-band verification via the distilled API.
      const liveConfig = yield* getConfiguration(
        zoneId,
        created.config.configId,
      );
      expect(liveConfig.credentials.keys.map((k) => k.kid)).toEqual([
        JWKS_KEY_1.kid,
      ]);
      const liveRule = yield* getRule(zoneId, created.rule.ruleId);
      expect(liveRule.action).toEqual("log");

      // -- Update in place: patch metadata, rotate keys, flip the rule ---
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const config = yield* Cloudflare.TokenValidation.TokenConfiguration(
            "JwtConfig",
            {
              zoneId,
              description: "v2",
              tokenSources: [
                'http.request.headers["authorization"][0]',
                'http.request.uri.args["token"][0]',
              ],
              keys: [JWKS_KEY_1, JWKS_KEY_2],
            },
          );
          const rule = yield* Cloudflare.TokenValidation.Rule("JwtRule", {
            zoneId,
            description: "v2",
            enabled: false,
            action: "block",
            expression: Output.interpolate`is_jwt_valid("${config.configId}")`,
            selector: { include: [{ host: [zoneName] }] },
          });
          return { config, rule };
        }),
      );

      // Same physical resources — patched in place, not replaced.
      expect(updated.config.configId).toEqual(created.config.configId);
      expect(updated.config.description).toEqual("v2");
      expect(updated.config.tokenSources).toHaveLength(2);
      expect(updated.config.keys.map((k) => k.kid).sort()).toEqual([
        JWKS_KEY_1.kid,
        JWKS_KEY_2.kid,
      ]);
      expect(updated.rule.ruleId).toEqual(created.rule.ruleId);
      expect(updated.rule.action).toEqual("block");
      expect(updated.rule.enabled).toEqual(false);

      const rotated = yield* getConfiguration(zoneId, updated.config.configId);
      expect(rotated.credentials.keys).toHaveLength(2);

      // -- Destroy: rule first (it references the config), then config ---
      yield* stack.destroy();

      const configGone = yield* getConfiguration(
        zoneId,
        updated.config.configId,
      ).pipe(Effect.flip);
      expect(configGone._tag).toEqual("TokenConfigurationNotFound");
      const ruleGone = yield* getRule(zoneId, updated.rule.ruleId).pipe(
        Effect.flip,
      );
      expect(ruleGone._tag).toEqual("TokenValidationRuleNotFound");

      // Destroy is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
