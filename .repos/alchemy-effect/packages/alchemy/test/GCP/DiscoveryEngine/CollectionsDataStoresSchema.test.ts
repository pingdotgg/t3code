import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import { quotaTolerant } from "./parent.ts";
import * as Test from "@/Test/Alchemy";
import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsDataStoresSchemas({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsCollectionsDataStoresSchemas on a missing schema fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsDataStoresSchemas({
          name: `projects/${project}/locations/global/collections/default_collection/dataStores/alchemy-missing/schemas/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a collection data store schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {
            location: "global",
            displayName: "docs",
            skipDefaultSchemaCreation: true,
            disableCmek: true,
          });
        }),
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: parent.dataStoreId,
              location: "global",
              collection: parent.collection,
              displayName: "docs",
              skipDefaultSchemaCreation: true,
              disableCmek: true,
            },
          );
          const schema = yield* GCP.DiscoveryEngine.CollectionsDataStoresSchema(
            "Fields",
            {
              dataStore: store.name,
              schemaId: "fields",
              jsonSchema: JSON.stringify({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { title: { type: "string" } },
              }),
            },
          );
          return { store, schema };
        }),
      );

      expect(created.schema.name).toContain("/schemas/");
      expect(created.schema.jsonSchema).toContain("title");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsDataStoresSchemas(
          { name: created.schema.name },
        );
      expect(fetched.name).toEqual(created.schema.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              collection: created.store.collection,
              displayName: "docs",
              disableCmek: true,
            },
          );
          const schema = yield* GCP.DiscoveryEngine.CollectionsDataStoresSchema(
            "Fields",
            {
              dataStore: store.name,
              schemaId: "fields",
              jsonSchema: JSON.stringify({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                  title: { type: "string" },
                  uri: { type: "string" },
                },
              }),
            },
          );
          return { store, schema };
        }),
      );

      expect(updated.schema.name).toEqual(created.schema.name);
      expect(updated.schema.jsonSchema).toContain("uri");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.schema.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
