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
  tableId: string,
  policyId: string,
) =>
  bigquery
    .getRowAccessPolicies({
      projectId,
      datasetId,
      tableId,
      policyId,
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
  "create, update, and delete a row access policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const table = yield* GCP.BigQuery.Table("Events", {
            datasetId: dataset.datasetId,
            schema: [{ name: "nullable_field", type: "STRING" }],
          });
          return yield* GCP.BigQuery.RowAccessPolicy("Visible", {
            datasetId: dataset.datasetId,
            tableId: table.tableId,
            filterPredicate: "nullable_field IS NOT NULL",
          });
        }),
      );

      expect(created.policyId).toEqual(expect.any(String));
      expect(created.policyId).toMatch(/^[a-zA-Z0-9_]+$/);
      expect(created.datasetId).toEqual(expect.any(String));
      expect(created.tableId).toEqual(expect.any(String));
      expect(created.project).toEqual(expect.any(String));
      expect(created.filterPredicate).toEqual("nullable_field IS NOT NULL");

      const fetched = yield* bigquery.getRowAccessPolicies({
        projectId: created.project,
        datasetId: created.datasetId,
        tableId: created.tableId,
        policyId: created.policyId,
      });
      expect(fetched.rowAccessPolicyReference?.policyId).toEqual(
        created.policyId,
      );
      // The predicate is sent verbatim — no ownership tautology.
      expect(fetched.filterPredicate).toEqual("nullable_field IS NOT NULL");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            datasetId: created.datasetId,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const table = yield* GCP.BigQuery.Table("Events", {
            datasetId: dataset.datasetId,
            tableId: created.tableId,
            schema: [{ name: "nullable_field", type: "STRING" }],
          });
          return yield* GCP.BigQuery.RowAccessPolicy("Visible", {
            datasetId: dataset.datasetId,
            tableId: table.tableId,
            policyId: created.policyId,
            filterPredicate: "TRUE",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.policyId).toEqual(created.policyId);
      expect(updated.filterPredicate).toEqual("TRUE");

      const fetchedUpdate = yield* bigquery.getRowAccessPolicies({
        projectId: created.project,
        datasetId: created.datasetId,
        tableId: created.tableId,
        policyId: created.policyId,
      });
      expect(fetchedUpdate.filterPredicate).toEqual("TRUE");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.datasetId,
        created.tableId,
        created.policyId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 90_000 },
);
