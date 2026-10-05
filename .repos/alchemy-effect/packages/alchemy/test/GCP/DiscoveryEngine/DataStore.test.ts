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
  discoveryengine.getProjectsLocationsDataStores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataStores on a missing store fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsDataStores({
          name: `projects/${project}/locations/global/dataStores/alchemy-ds-missing`,
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
  "create, update, and delete a data store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.DataStore("Docs", {
            location: "global",
            displayName: "docs",
            industryVertical: "GENERIC",
            contentConfig: "NO_CONTENT",
            solutionTypes: ["SOLUTION_TYPE_SEARCH"],
            disableCmek: true,
          });
        }),
      );

      expect(created.name).toContain("/dataStores/");
      expect(created.location).toEqual("global");
      expect(created.displayName).toEqual("docs");
      expect(created.industryVertical).toEqual("GENERIC");

      const fetched = yield* discoveryengine.getProjectsLocationsDataStores({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("docs");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.DataStore("Docs", {
            dataStoreId: created.dataStoreId,
            location: "global",
            displayName: "docs-prod",
            industryVertical: "GENERIC",
            contentConfig: "NO_CONTENT",
            solutionTypes: ["SOLUTION_TYPE_SEARCH"],
            disableCmek: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("docs-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
