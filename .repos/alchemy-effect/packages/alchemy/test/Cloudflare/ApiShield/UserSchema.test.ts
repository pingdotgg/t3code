import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test schema names.
const NAME_DEFAULT = "alch-userschema-default";
const NAME_REPLACE = "alch-userschema-replace";
const NAME_LIST = "alch-userschema-list";

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

const fixture = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(
      path.join(import.meta.dirname, "fixtures", file),
    );
  });

// The scoped API token the test harness mints propagates eventually-
// consistently — a fresh token intermittently 403s. Ride out the blips on
// the test's own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

// Read a schema out-of-band; `undefined` when gone.
const getSchema = (zoneId: string, schemaId: string) =>
  apiGateway.getUserSchema({ zoneId, schemaId }).pipe(
    Effect.map(
      (schema): apiGateway.GetUserSchemaResponse | undefined => schema,
    ),
    Effect.catchTag("SchemaNotFound", () => Effect.succeed(undefined)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Purge schemas left over from interrupted runs so each test starts clean.
const purgeSchemasNamed = (zoneId: string, name: string) =>
  apiGateway.listUserSchemas.items({ zoneId, omitSource: true }).pipe(
    Stream.runCollect,
    Effect.flatMap((chunk) =>
      Effect.forEach(
        Array.from(chunk).filter((schema) => schema.name === name),
        (schema) =>
          apiGateway
            .deleteUserSchema({ zoneId, schemaId: schema.schemaId })
            .pipe(Effect.catchTag("SchemaNotFound", () => Effect.void)),
      ),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "create, enable validation in place, destroy a user schema",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const source = yield* fixture("openapi-v1.json");

      yield* stack.destroy();
      yield* purgeSchemasNamed(zoneId, NAME_DEFAULT);

      const schema = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("DefaultSchema", {
            zoneId,
            name: NAME_DEFAULT,
            schema: source,
          }).pipe(adopt(true));
        }),
      );

      expect(schema.zoneId).toEqual(zoneId);
      expect(schema.name).toEqual(NAME_DEFAULT);
      expect(schema.kind).toEqual("openapi_v3");
      expect(schema.source).toEqual(source);
      expect(schema.validationEnabled).toEqual(false);
      expect(schema.schemaId.length).toBeGreaterThan(0);

      const live = yield* getSchema(zoneId, schema.schemaId);
      expect(live?.name).toEqual(NAME_DEFAULT);
      expect(live?.source).toEqual(source);

      // Enable validation — same identity, patched in place.
      const enabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("DefaultSchema", {
            zoneId,
            name: NAME_DEFAULT,
            schema: source,
            validationEnabled: true,
          }).pipe(adopt(true));
        }),
      );
      expect(enabled.schemaId).toEqual(schema.schemaId);
      expect(enabled.validationEnabled).toEqual(true);

      const patched = yield* getSchema(zoneId, schema.schemaId);
      expect(patched?.validationEnabled).toEqual(true);

      yield* stack.destroy();

      const gone = yield* getSchema(zoneId, schema.schemaId);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "changing the schema source triggers replacement",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const sourceV1 = yield* fixture("openapi-v1.json");
      const sourceV2 = yield* fixture("openapi-v2.json");

      yield* stack.destroy();
      yield* purgeSchemasNamed(zoneId, NAME_REPLACE);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("ReplaceSchema", {
            zoneId,
            name: NAME_REPLACE,
            schema: sourceV1,
          }).pipe(adopt(true));
        }),
      );
      expect(initial.source).toEqual(sourceV1);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("ReplaceSchema", {
            zoneId,
            name: NAME_REPLACE,
            schema: sourceV2,
          }).pipe(adopt(true));
        }),
      );

      // The source is immutable — a new physical schema exists.
      expect(replaced.schemaId).not.toEqual(initial.schemaId);
      expect(replaced.source).toEqual(sourceV2);

      // The old schema was deleted as part of the replacement.
      const oldSchema = yield* getSchema(zoneId, initial.schemaId);
      expect(oldSchema).toBeUndefined();

      const live = yield* getSchema(zoneId, replaced.schemaId);
      expect(live?.source).toEqual(sourceV2);

      yield* stack.destroy();

      const gone = yield* getSchema(zoneId, replaced.schemaId);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped collection): `list()` fans out over
// every zone via `listAllZones` and exhaustively paginates each zone's
// schemas. Deploy a schema, then assert its id appears in the result.
test.provider(
  "list enumerates the deployed user schema",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const source = yield* fixture("openapi-v1.json");

      yield* stack.destroy();
      yield* purgeSchemasNamed(zoneId, NAME_LIST);

      const schema = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("ListSchema", {
            zoneId,
            name: NAME_LIST,
            schema: source,
          }).pipe(adopt(true));
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.ApiShield.UserSchema,
      );
      const all = yield* provider.list();

      const found = all.find((s) => s.schemaId === schema.schemaId);
      expect(found).toBeDefined();
      expect(found?.zoneId).toEqual(zoneId);
      expect(found?.name).toEqual(NAME_LIST);
      expect(found?.kind).toEqual("openapi_v3");
      expect(found?.source).toEqual(source);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
