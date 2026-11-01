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
    .getProjectsLocationsCollectionsDataStoresBranchesDocuments({ name })
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
  "getProjectsLocationsCollectionsDataStoresBranchesDocuments on a missing document fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsDataStoresBranchesDocuments(
          {
            name: `projects/${project}/locations/global/collections/default_collection/dataStores/alchemy-missing/branches/default_branch/documents/alchemy-missing`,
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
  "create, update, and delete a collection data store document",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "docs",
              contentConfig: "NO_CONTENT",
              disableCmek: true,
            },
          );
          const document =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresBranchesDocument(
              "About",
              {
                dataStore: store.name,
                jsonData: JSON.stringify({
                  title: "About us",
                  uri: "https://example.com/about",
                }),
              },
            );
          return { store, document };
        }),
      );

      expect(created.document.name).toContain("/documents/");
      expect(created.document.dataStore).toEqual(created.store.name);

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsDataStoresBranchesDocuments(
          { name: created.document.name },
        );
      expect(fetched.name).toEqual(created.document.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.DiscoveryEngine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              collection: created.store.collection,
              displayName: "docs",
              contentConfig: "NO_CONTENT",
              disableCmek: true,
            },
          );
          const document =
            yield* GCP.DiscoveryEngine.CollectionsDataStoresBranchesDocument(
              "About",
              {
                dataStore: store.name,
                documentId: created.document.documentId,
                jsonData: JSON.stringify({
                  title: "About the team",
                  uri: "https://example.com/about",
                }),
              },
            );
          return { store, document };
        }),
      );

      expect(updated.document.name).toEqual(created.document.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.document.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
