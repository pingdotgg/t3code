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
const parentId = "alchds3doc";

const waitUntilGone = (name: string) =>
  discoveryengine
    .getProjectsLocationsDataStoresBranchesDocuments({ name })
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
  "getProjectsLocationsDataStoresBranchesDocuments on a missing document fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsDataStoresBranchesDocuments({
          name: `projects/${project}/locations/global/dataStores/alchemy-missing/branches/default_branch/documents/alchemy-missing`,
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
  "create, update, and delete a data store document",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const parent = yield* ensureDataStore(project, parentId, {
        contentConfig: "NO_CONTENT",
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.DataStoresBranchesDocument(
            "About",
            {
              dataStore: parent.name ?? "",
              jsonData: JSON.stringify({
                title: "About us",
                uri: "https://example.com/about",
              }),
            },
          );
        }),
      );

      expect(created.name).toContain("/documents/");
      expect(created.jsonData).toContain("About us");

      const fetched =
        yield* discoveryengine.getProjectsLocationsDataStoresBranchesDocuments({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.DataStoresBranchesDocument(
            "About",
            {
              dataStore: parent.name ?? "",
              documentId: created.documentId,
              jsonData: JSON.stringify({
                title: "About the team",
                uri: "https://example.com/about",
              }),
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.jsonData).toContain("About the team");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
