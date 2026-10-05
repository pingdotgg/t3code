import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { ensureDataStore, quotaTolerant } from "./parent.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;
const parentId = "alchds3svc";

const waitUntilGone = (name: string) =>
  discoveryengine.getProjectsLocationsDataStoresServingConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataStoresServingConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsDataStoresServingConfigs({
          name: `projects/${project}/locations/global/dataStores/alchemy-missing/servingConfigs/alchemymissing`,
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
  "create, update, and delete a data store serving config",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const parent = yield* ensureDataStore(project, parentId, {
        contentConfig: "NO_CONTENT",
        withEngine: true,
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.DataStoresServingConfig("Search", {
            dataStore: parent.name ?? "",
            displayName: "web-search",
            solutionType: "SOLUTION_TYPE_SEARCH",
          });
        }),
      );

      expect(created.name).toContain("/servingConfigs/");
      expect(created.displayName).toEqual("web-search");

      const fetched =
        yield* discoveryengine.getProjectsLocationsDataStoresServingConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.DataStoresServingConfig("Search", {
            dataStore: parent.name ?? "",
            servingConfigId: created.servingConfigId,
            displayName: "web-search-v2",
            solutionType: "SOLUTION_TYPE_SEARCH",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("web-search-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
