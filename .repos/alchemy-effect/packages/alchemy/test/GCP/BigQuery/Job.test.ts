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

const waitUntilGone = (projectId: string, jobId: string, location: string) =>
  bigquery
    .getJobs({
      projectId,
      jobId,
      location,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "create, replace, and delete a query job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQuery.Job("Count", {
            location: "US-CENTRAL1",
            labels: { env: "test" },
            query: { query: "SELECT 1 AS n", useLegacySql: false },
          });
        }),
      );

      expect(created.jobId).toEqual(expect.any(String));
      expect(created.project).toEqual(expect.any(String));
      expect(created.location.toUpperCase()).toEqual("US-CENTRAL1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.jobType).toEqual("QUERY");
      expect(created.state).toEqual("DONE");
      expect(created.errorResult).toBeUndefined();
      expect(created.query).toEqual("SELECT 1 AS n");

      const fetched = yield* bigquery.getJobs({
        projectId: created.project,
        jobId: created.jobId,
        location: created.location,
      });
      expect(fetched.jobReference?.jobId).toEqual(created.jobId);
      expect(fetched.configuration?.labels?.env).toEqual("test");
      expect(fetched.configuration?.labels?.["alchemy-id"]).toEqual(
        expect.any(String),
      );
      expect(fetched.configuration?.query?.query).toEqual("SELECT 1 AS n");
      expect(fetched.status?.state).toEqual("DONE");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQuery.Job("Count", {
            location: "US-CENTRAL1",
            labels: { env: "prod", role: "query" },
            query: { query: "SELECT 2 AS n", useLegacySql: false },
          });
        }),
      );

      expect(updated.jobId).toEqual(expect.any(String));
      expect(updated.jobId).not.toEqual(created.jobId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "query" });
      expect(updated.query).toEqual("SELECT 2 AS n");
      expect(updated.state).toEqual("DONE");
      expect(updated.errorResult).toBeUndefined();

      const fetchedUpdate = yield* bigquery.getJobs({
        projectId: updated.project,
        jobId: updated.jobId,
        location: updated.location,
      });
      expect(fetchedUpdate.configuration?.labels?.env).toEqual("prod");
      expect(fetchedUpdate.configuration?.labels?.role).toEqual("query");
      expect(fetchedUpdate.configuration?.query?.query).toEqual(
        "SELECT 2 AS n",
      );

      const oldGone = yield* waitUntilGone(
        created.project,
        created.jobId,
        created.location,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        updated.project,
        updated.jobId,
        updated.location,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 90_000 },
);
