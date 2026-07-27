import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as schemaValidation from "@distilled.cloud/cloudflare/schema-validation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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

const readFixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(
      path.join(import.meta.dirname, "fixtures", name),
    );
  });

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error.
const getSchemaOob = (zoneId: string, schemaId: string) =>
  schemaValidation.getSchema({ zoneId, schemaId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider(
  "uploads a schema, enables in place, replaces on disable and source change, destroys",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const v1 = yield* readFixture("openapi-v1.json");
      const v2 = yield* readFixture("openapi-v2.json");

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SchemaValidation.SchemaValidationSchema(
            "TestSchema",
            {
              zoneId,
              source: v1,
              validationEnabled: false,
            },
          );
        }),
      );

      expect(created.schemaId).toBeTruthy();
      expect(created.zoneId).toEqual(zoneId);
      expect(created.kind).toEqual("openapi_v3");
      expect(created.validationEnabled).toEqual(false);

      const live = yield* getSchemaOob(zoneId, created.schemaId);
      expect(live.name).toEqual(created.name);
      expect(live.source).toEqual(v1);
      expect(live.validationEnabled ?? false).toEqual(false);

      // Enabling (false → true) is the one in-place update.
      const enabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SchemaValidation.SchemaValidationSchema(
            "TestSchema",
            {
              zoneId,
              source: v1,
              validationEnabled: true,
            },
          );
        }),
      );
      expect(enabled.schemaId).toEqual(created.schemaId);
      expect(enabled.validationEnabled).toEqual(true);
      expect(enabled.source).toEqual(v1);

      const enabledLive = yield* getSchemaOob(zoneId, enabled.schemaId);
      expect(enabledLive.validationEnabled).toEqual(true);

      // Cloudflare rejects disabling in place — true → false replaces the
      // schema (new id, old one deleted).
      const disabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SchemaValidation.SchemaValidationSchema(
            "TestSchema",
            {
              zoneId,
              source: v1,
              validationEnabled: false,
            },
          );
        }),
      );
      expect(disabled.schemaId).not.toEqual(created.schemaId);
      expect(disabled.validationEnabled).toEqual(false);

      const firstGone = yield* schemaValidation
        .getSchema({ zoneId, schemaId: created.schemaId })
        .pipe(Effect.flip);
      expect(firstGone._tag).toEqual("SchemaNotFound");

      // The schema body is immutable — changing the source uploads a new
      // schema (new id) and deletes the old one.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SchemaValidation.SchemaValidationSchema(
            "TestSchema",
            {
              zoneId,
              source: v2,
            },
          );
        }),
      );
      expect(replaced.schemaId).not.toEqual(disabled.schemaId);
      expect(replaced.source).toEqual(v2);

      const oldGone = yield* schemaValidation
        .getSchema({ zoneId, schemaId: disabled.schemaId })
        .pipe(Effect.flip);
      expect(oldGone._tag).toEqual("SchemaNotFound");

      yield* stack.destroy();

      const gone = yield* schemaValidation
        .getSchema({ zoneId, schemaId: replaced.schemaId })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("SchemaNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped collection): `list()` enumerates every
// zone in the account via `listAllZones` and exhaustively paginates each
// zone's schemas. Deploy a real schema and assert it appears in the result.
test.provider(
  "list enumerates the deployed schema across all zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const v1 = yield* readFixture("openapi-v1.json");

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SchemaValidation.SchemaValidationSchema(
            "ListSchema",
            {
              zoneId,
              source: v1,
              validationEnabled: false,
            },
          );
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.SchemaValidation.SchemaValidationSchema,
      );
      const all = yield* provider.list();

      expect(
        all.some(
          (s) => s.schemaId === deployed.schemaId && s.zoneId === zoneId,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
