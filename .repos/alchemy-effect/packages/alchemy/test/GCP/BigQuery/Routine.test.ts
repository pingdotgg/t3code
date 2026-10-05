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

const waitUntilGone = (
  projectId: string,
  datasetId: string,
  routineId: string,
) =>
  bigquery
    .getRoutines({
      projectId,
      datasetId,
      routineId,
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
  "create, update, and delete a routine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.BigQuery.Routine("Triple", {
            datasetId: dataset.datasetId,
            routineType: "SCALAR_FUNCTION",
            language: "SQL",
            definitionBody: "x * 3",
            arguments: [{ name: "x", dataType: { typeKind: "INT64" } }],
            returnType: { typeKind: "INT64" },
            description: "multiply by three",
          });
        }),
      );

      expect(created.routineId).toEqual(expect.any(String));
      expect(created.routineId).toMatch(/^[a-zA-Z0-9_]+$/);
      expect(created.datasetId).toEqual(expect.any(String));
      expect(created.project).toEqual(expect.any(String));
      expect(created.routineType).toEqual("SCALAR_FUNCTION");
      expect(created.language).toEqual("SQL");
      expect(created.definitionBody).toEqual("x * 3");
      expect(created.description).toEqual("multiply by three");
      expect(created.returnType).toMatchObject({ typeKind: "INT64" });
      expect(created.arguments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "x",
            dataType: expect.objectContaining({ typeKind: "INT64" }),
          }),
        ]),
      );

      const fetched = yield* bigquery.getRoutines({
        projectId: created.project,
        datasetId: created.datasetId,
        routineId: created.routineId,
      });
      expect(fetched.routineReference?.routineId).toEqual(created.routineId);
      expect(fetched.routineType).toEqual("SCALAR_FUNCTION");
      expect(fetched.language).toEqual("SQL");
      expect(fetched.definitionBody).toEqual("x * 3");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("multiply by three");
      expect(fetched.returnType?.typeKind).toEqual("INT64");

      const queried = yield* bigquery.queryJobs({
        projectId: created.project,
        body: {
          query: `SELECT \`${created.project}.${created.datasetId}.${created.routineId}\`(2) AS n`,
          useLegacySql: false,
          location: "US-CENTRAL1",
        },
      });
      expect(queried.jobComplete).toEqual(true);
      expect(queried.rows?.[0]?.f?.[0]?.v).toEqual("6");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            datasetId: created.datasetId,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.BigQuery.Routine("Triple", {
            datasetId: dataset.datasetId,
            routineId: created.routineId,
            routineType: "SCALAR_FUNCTION",
            language: "SQL",
            definitionBody: "x * 4",
            arguments: [{ name: "x", dataType: { typeKind: "INT64" } }],
            returnType: { typeKind: "INT64" },
            description: "multiply by four",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.routineId).toEqual(created.routineId);
      expect(updated.definitionBody).toEqual("x * 4");
      expect(updated.description).toEqual("multiply by four");

      const fetchedUpdate = yield* bigquery.getRoutines({
        projectId: created.project,
        datasetId: created.datasetId,
        routineId: created.routineId,
      });
      expect(fetchedUpdate.definitionBody).toEqual("x * 4");
      expect(fetchedUpdate.description).toContain("alchemy-id=");
      expect(fetchedUpdate.description).toContain("multiply by four");

      const queriedUpdate = yield* bigquery.queryJobs({
        projectId: created.project,
        body: {
          query: `SELECT \`${created.project}.${created.datasetId}.${created.routineId}\`(2) AS n`,
          useLegacySql: false,
          location: "US-CENTRAL1",
        },
      });
      expect(queriedUpdate.jobComplete).toEqual(true);
      expect(queriedUpdate.rows?.[0]?.f?.[0]?.v).toEqual("8");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.datasetId,
        created.routineId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 90_000 },
);
