import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (projectId: string, datasetId: string) =>
  bigquery.getDatasets({ projectId, datasetId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQuery.Dataset("Analytics", {
            location: "US-CENTRAL1",
            labels: { env: "test" },
            description: "alchemy test dataset",
            forceDestroy: true,
          });
        }),
      );

      expect(created.datasetId).toEqual(expect.any(String));
      expect(created.datasetId).toMatch(/^[a-zA-Z0-9_]+$/);
      expect(created.location.toUpperCase()).toEqual("US-CENTRAL1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.description).toEqual("alchemy test dataset");

      const fetched = yield* bigquery.getDatasets({
        projectId: created.project,
        datasetId: created.datasetId,
      });
      expect(fetched.datasetReference?.datasetId).toEqual(created.datasetId);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("alchemy test dataset");

      const queried = yield* bigquery.queryJobs({
        projectId: created.project,
        body: {
          query: "SELECT 1 AS n",
          useLegacySql: false,
          location: created.location,
          defaultDataset: {
            projectId: created.project,
            datasetId: created.datasetId,
          },
        },
      });
      expect(queried.jobComplete).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQuery.Dataset("Analytics", {
            datasetId: created.datasetId,
            location: "US-CENTRAL1",
            labels: { env: "prod", role: "analytics" },
            description: "updated analytics",
            friendlyName: "analytics",
            defaultTableExpirationMs: "3600000",
            forceDestroy: true,
          });
        }),
      );

      expect(updated.datasetId).toEqual(created.datasetId);
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "analytics",
      });
      expect(updated.description).toEqual("updated analytics");
      expect(updated.friendlyName).toEqual("analytics");
      expect(updated.defaultTableExpirationMs).toEqual("3600000");

      const fetchedUpdate = yield* bigquery.getDatasets({
        projectId: created.project,
        datasetId: created.datasetId,
      });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("analytics");
      expect(fetchedUpdate.description).toEqual("updated analytics");
      expect(fetchedUpdate.friendlyName).toEqual("analytics");
      expect(fetchedUpdate.defaultTableExpirationMs).toEqual("3600000");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.datasetId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 90_000 },
);
