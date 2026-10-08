import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as analyticshub from "@distilled.cloud/gcp/analyticshub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  analyticshub.getProjectsLocationsDataExchanges({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("InternalServerError", () =>
      Effect.succeed("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

test.provider(
  "getProjectsLocationsDataExchanges on a missing exchange fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        analyticshub.getProjectsLocationsDataExchanges({
          name: `projects/${project}/locations/${location}/dataExchanges/alchemy_missing_exchange`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:analyticshub", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data exchange",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AnalyticsHub.DataExchange("Marketplace", {
            location,
            displayName: "Marketplace",
            description: "shared datasets",
            primaryContact: "data@example.com",
          });
        }),
      );

      expect(created.name).toContain("/dataExchanges/");
      expect(created.location.toLowerCase()).toEqual(location);
      expect(created.displayName).toEqual("Marketplace");
      expect(created.description).toEqual("shared datasets");
      expect(created.primaryContact).toEqual("data@example.com");
      expect(created.dataExchangeId).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);

      const fetched = yield* analyticshub.getProjectsLocationsDataExchanges({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("Marketplace");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("shared datasets");
      expect(fetched.primaryContact).toEqual("data@example.com");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AnalyticsHub.DataExchange("Marketplace", {
            dataExchangeId: created.dataExchangeId,
            location,
            displayName: "Marketplace v2",
            description: "updated catalogs",
            primaryContact: "catalog@example.com",
            documentation: "https://example.com/docs",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Marketplace v2");
      expect(updated.description).toEqual("updated catalogs");
      expect(updated.primaryContact).toEqual("catalog@example.com");
      expect(updated.documentation).toEqual("https://example.com/docs");

      const fetchedUpdate =
        yield* analyticshub.getProjectsLocationsDataExchanges({
          name: created.name,
        });
      expect(fetchedUpdate.displayName).toEqual("Marketplace v2");
      expect(fetchedUpdate.description).toContain("updated catalogs");
      expect(fetchedUpdate.primaryContact).toEqual("catalog@example.com");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:analyticshub", "live"],
    timeout: 90_000,
  },
);
