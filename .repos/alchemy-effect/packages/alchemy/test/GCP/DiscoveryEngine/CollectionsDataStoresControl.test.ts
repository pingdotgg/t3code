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
    .getProjectsLocationsCollectionsDataStoresControls({ name })
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
  "getProjectsLocationsCollectionsDataStoresControls on a missing control fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsDataStoresControls({
          name: `projects/${project}/locations/global/collections/default_collection/dataStores/alchemy-missing/controls/alchemy-missing`,
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
  "create, update, and delete a collection data store control",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "docs",
              disableCmek: true,
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "eng",
              solutionType: "SOLUTION_TYPE_SEARCH",
              industryVertical: "GENERIC",
            },
          );
          return { store, engine };
        }),
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: parent.store.dataStoreId,
              location: "global",
              collection: parent.store.collection,
              displayName: "docs",
              disableCmek: true,
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              engineId: parent.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "eng",
              solutionType: "SOLUTION_TYPE_SEARCH",
              industryVertical: "GENERIC",
            },
          );
          const control =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresControl(
              "Greetings",
              {
                dataStore: store.name,
                displayName: parent.engine.engineId.slice(0, 2),
                synonyms: ["hello", "hi"],
              },
            );
          return { store, engine, control };
        }),
      );

      expect(created.control.name).toContain("/controls/");
      expect(created.control.synonyms).toEqual(
        expect.arrayContaining(["hello", "hi"]),
      );

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsDataStoresControls(
          { name: created.control.name },
        );
      expect(fetched.name).toEqual(created.control.name);
      expect(fetched.displayName).toEqual(created.control.displayName);

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
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              engineId: created.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "eng",
              solutionType: "SOLUTION_TYPE_SEARCH",
              industryVertical: "GENERIC",
            },
          );
          const control =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresControl(
              "Greetings",
              {
                dataStore: store.name,
                controlId: created.control.controlId,
                displayName: created.engine.engineId.slice(0, 4),
                synonyms: ["hello", "hi"],
              },
            );
          return { store, engine, control };
        }),
      );

      expect(updated.control.name).toEqual(created.control.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.control.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
