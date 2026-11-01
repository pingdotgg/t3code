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

const waitUntilGone = (projectId: string, datasetId: string, tableId: string) =>
  bigquery
    .getTables({
      projectId,
      datasetId,
      tableId,
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
  "create, update, and delete a table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.BigQuery.Table("Events", {
            datasetId: dataset.datasetId,
            schema: [
              { name: "id", type: "STRING" },
              { name: "created_at", type: "TIMESTAMP" },
            ],
            labels: { env: "test" },
            description: "order events",
            timePartitioning: { type: "DAY", field: "created_at" },
            clustering: { fields: ["id"] },
          });
        }),
      );

      expect(created.tableId).toEqual(expect.any(String));
      expect(created.tableId).toMatch(/^[a-zA-Z0-9_]+$/);
      expect(created.datasetId).toEqual(expect.any(String));
      expect(created.project).toEqual(expect.any(String));
      expect(created.type).toEqual("TABLE");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.description).toEqual("order events");
      expect(created.timePartitioning).toMatchObject({
        type: "DAY",
        field: "created_at",
      });
      expect(created.clustering).toEqual({ fields: ["id"] });
      expect(created.schema).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "id", type: "STRING" }),
          expect.objectContaining({ name: "created_at", type: "TIMESTAMP" }),
        ]),
      );

      const fetched = yield* bigquery.getTables({
        projectId: created.project,
        datasetId: created.datasetId,
        tableId: created.tableId,
        view: "FULL",
      });
      expect(fetched.tableReference?.tableId).toEqual(created.tableId);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.description).toEqual("order events");
      expect(fetched.timePartitioning?.type).toEqual("DAY");
      expect(fetched.timePartitioning?.field).toEqual("created_at");
      expect(fetched.clustering?.fields).toEqual(["id"]);

      const inserted = yield* bigquery.insertAllTabledata({
        projectId: created.project,
        datasetId: created.datasetId,
        tableId: created.tableId,
        body: {
          rows: [{ json: { id: "row-1", created_at: "2024-01-01T00:00:00Z" } }],
        },
      });
      expect(inserted.insertErrors ?? []).toEqual([]);

      const listed = yield* bigquery
        .listTabledata({
          projectId: created.project,
          datasetId: created.datasetId,
          tableId: created.tableId,
          maxResults: 10,
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (page) => (page.rows ?? []).length > 0,
            times: 10,
          }),
        );
      expect((listed.rows ?? []).length).toBeGreaterThan(0);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            datasetId: created.datasetId,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.BigQuery.Table("Events", {
            datasetId: dataset.datasetId,
            tableId: created.tableId,
            schema: [
              { name: "id", type: "STRING" },
              { name: "created_at", type: "TIMESTAMP" },
              { name: "name", type: "STRING" },
            ],
            labels: { env: "prod", role: "events" },
            description: "order events v2",
            friendlyName: "Order Events",
            timePartitioning: {
              type: "DAY",
              field: "created_at",
              expirationMs: "2592000000",
            },
            clustering: { fields: ["id"] },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.tableId).toEqual(created.tableId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "events" });
      expect(updated.description).toEqual("order events v2");
      expect(updated.friendlyName).toEqual("Order Events");
      expect(updated.schema).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "id", type: "STRING" }),
          expect.objectContaining({ name: "created_at", type: "TIMESTAMP" }),
          expect.objectContaining({ name: "name", type: "STRING" }),
        ]),
      );
      expect(updated.timePartitioning).toMatchObject({
        type: "DAY",
        field: "created_at",
        expirationMs: "2592000000",
      });

      const fetchedUpdate = yield* bigquery.getTables({
        projectId: created.project,
        datasetId: created.datasetId,
        tableId: created.tableId,
        view: "FULL",
      });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("events");
      expect(fetchedUpdate.description).toEqual("order events v2");
      expect(fetchedUpdate.friendlyName).toEqual("Order Events");
      expect(fetchedUpdate.timePartitioning?.expirationMs).toEqual(
        "2592000000",
      );
      expect(
        (fetchedUpdate.schema?.fields ?? []).map((field) => field.name),
      ).toEqual(expect.arrayContaining(["id", "created_at", "name"]));

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.datasetId,
        created.tableId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 90_000 },
);
