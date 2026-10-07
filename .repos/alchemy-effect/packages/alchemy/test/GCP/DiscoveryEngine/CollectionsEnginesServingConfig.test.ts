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
    .getProjectsLocationsCollectionsEnginesServingConfigs({ name })
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
  "getProjectsLocationsCollectionsEnginesServingConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsEnginesServingConfigs({
          name: `projects/${project}/locations/global/collections/default_collection/engines/alchemy-missing/servingConfigs/alchemy-missing`,
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
  "create, update, and delete an engine serving config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "serving-docs",
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "serving engine",
            },
          );
          const serving =
            yield* GCP.DiscoveryEngine.CollectionsEnginesServingConfig(
              "Primary",
              {
                engine: engine.name,
                displayName: "primary",
                solutionType: "SOLUTION_TYPE_SEARCH",
              },
            );
          return { store, engine, serving };
        }),
      );

      expect(created.serving.name).toContain("/servingConfigs/");
      expect(created.serving.engine).toEqual(created.engine.name);
      expect(created.serving.displayName).toEqual("primary");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsEnginesServingConfigs(
          { name: created.serving.name },
        );
      expect(fetched.name).toEqual(created.serving.name);
      expect(fetched.displayName).toEqual("primary");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              displayName: "serving-docs",
            },
          );
          const engine = yield* GCP.DiscoveryEngine.CollectionsEngine(
            "Search",
            {
              engineId: created.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "serving engine",
            },
          );
          const serving =
            yield* GCP.DiscoveryEngine.CollectionsEnginesServingConfig(
              "Primary",
              {
                engine: engine.name,
                servingConfigId: created.serving.servingConfigId,
                displayName: "primary-prod",
                solutionType: "SOLUTION_TYPE_SEARCH",
              },
            );
          return { store, engine, serving };
        }),
      );

      expect(updated.serving.name).toEqual(created.serving.name);
      expect(updated.serving.displayName).toEqual("primary-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.serving.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
