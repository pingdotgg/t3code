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
    .getProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites({
      name,
    })
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
  "getProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites on a missing target site fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites(
          {
            name: `projects/${project}/locations/global/collections/default_collection/dataStores/alchemy-missing/siteSearchEngine/targetSites/alchemy-missing`,
          },
        ),
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
  "create, update, and delete a collection data store target site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Web", {
            location: "global",
            displayName: "docs",
            contentConfig: "PUBLIC_WEBSITE",
            disableCmek: true,
          });
          const site =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSite(
              "Docs",
              {
                dataStore: store.name,
                providedUriPattern: "www.example.com/docs/",
                type: "INCLUDE",
              },
            );
          return { store, site };
        }),
      );

      expect(created.site.name).toContain("/targetSites/");
      expect(created.site.type).toEqual("INCLUDE");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites(
          { name: created.site.name },
        );
      expect(fetched.name).toEqual(created.site.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Web", {
            dataStoreId: created.store.dataStoreId,
            location: "global",
            collection: created.store.collection,
            displayName: "docs",
            contentConfig: "PUBLIC_WEBSITE",
            disableCmek: true,
          });
          const site =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSite(
              "Docs",
              {
                dataStore: store.name,
                providedUriPattern: "www.example.com/docs/",
                type: "EXCLUDE",
              },
            );
          return { store, site };
        }),
      );

      expect(updated.site.name).toEqual(created.site.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.site.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
