import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as schemaValidation from "@distilled.cloud/cloudflare/schema-validation";
import { expect } from "alchemy-test";
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

// Retry 403 blips while the harness-minted scoped token propagates.
const getOverrideOob = (zoneId: string, operationId: string) =>
  schemaValidation.getSettingOperation({ zoneId, operationId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider(
  "sets a per-operation override, updates it in place, and clears it on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const program = (
        mitigationAction: Cloudflare.SchemaValidation.OperationMitigationAction,
      ) =>
        Effect.gen(function* () {
          const op = yield* Cloudflare.ApiShield.Operation("TestOp", {
            zoneId,
            method: "GET",
            host: zoneName,
            endpoint: "/alchemy-sv-operation-setting-test",
          });
          const override = yield* Cloudflare.SchemaValidation.OperationSetting(
            "TestOverride",
            {
              zoneId,
              operationId: op.operationId,
              mitigationAction,
            },
          );
          return { op, override };
        });

      // "log" is plan-gated on this zone (UnentitledMitigationAction,
      // code 11400) — exercise the entitled "block"/"none" actions.
      const first = yield* stack.deploy(program("block"));
      expect(first.override.zoneId).toEqual(zoneId);
      expect(first.override.operationId).toEqual(first.op.operationId);
      expect(first.override.mitigationAction).toEqual("block");

      const live = yield* getOverrideOob(zoneId, first.op.operationId);
      expect(live.mitigationAction).toEqual("block");

      // The PUT is a true upsert — flipping the action updates in place.
      const second = yield* stack.deploy(program("none"));
      expect(second.override.operationId).toEqual(first.op.operationId);
      expect(second.override.mitigationAction).toEqual("none");

      const liveUpdated = yield* getOverrideOob(zoneId, first.op.operationId);
      expect(liveUpdated.mitigationAction).toEqual("none");

      const operationId = first.op.operationId;
      yield* stack.destroy();

      // Destroy cleared the override (the operation itself is destroyed
      // too, which cascades — either way the override is gone).
      const gone = yield* schemaValidation
        .getSettingOperation({ zoneId, operationId })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("OperationNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped collection): there is no account-wide
// API for per-operation overrides, so `list()` enumerates every zone via
// `listAllZones` and exhaustively paginates each zone's operation settings.
// Deploy one override and assert it appears in the result, keyed by its
// (zoneId, operationId) identity.
test.provider(
  "list enumerates the deployed per-operation override",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const op = yield* Cloudflare.ApiShield.Operation("ListOp", {
            zoneId,
            method: "GET",
            host: zoneName,
            endpoint: "/alchemy-sv-operation-setting-list-test",
          });
          const override = yield* Cloudflare.SchemaValidation.OperationSetting(
            "ListOverride",
            {
              zoneId,
              operationId: op.operationId,
              mitigationAction: "block",
            },
          );
          return { op, override };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.SchemaValidation.OperationSetting,
      );
      const all = yield* provider.list();

      expect(
        all.some(
          (o) =>
            o.zoneId === zoneId &&
            o.operationId === deployed.op.operationId &&
            o.mitigationAction === "block",
        ),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
