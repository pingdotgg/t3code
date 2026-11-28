import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
      expect(fetchedUpdate.timePartitioning?.expirationMs).toEqual("2592000000");
      expect((fetchedUpdate.schema?.fields ?? []).map((field) => field.name)).toEqual(
        expect.arrayContaining(["id", "created_at", "name"]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.datasetId, created.tableId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 90_000 },
);

const tableStatus = (projectId: string, datasetId: string, tableId: string) =>
  bigquery.getTables({ projectId, datasetId, tableId, view: "FULL" });

test.provider(
  "create, update, and replace a view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const viewStack = (props: { datasetId?: string; query?: string }) =>
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            datasetId: props.datasetId,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const events = yield* GCP.BigQuery.Table("Events", {
            datasetId: dataset.datasetId,
            schema: [
              { name: "id", type: "STRING" },
              { name: "n", type: "INT64" },
            ],
          });
          return yield* GCP.BigQuery.Table("EventIds", {
            datasetId: dataset.datasetId,
            ...(props.query === undefined
              ? { schema: [{ name: "id", type: "STRING" }] }
              : {
                  view: {
                    query: Output.interpolate`${props.query} FROM ${events.datasetId}.${events.tableId}`,
                  },
                }),
          });
        });

      const created = yield* stack.deploy(viewStack({ query: "SELECT id" }));
      expect(created.type).toEqual("VIEW");
      expect(created.view?.query).toMatch(/^SELECT id FROM /);
      expect(created.view?.useLegacySql).toEqual(false);

      const fetched = yield* tableStatus(created.project, created.datasetId, created.tableId);
      expect(fetched.type).toEqual("VIEW");
      expect(fetched.view?.useLegacySql).toEqual(false);
      expect((fetched.schema?.fields ?? []).map((field) => field.name)).toEqual(["id"]);

      const updated = yield* stack.deploy(
        viewStack({ datasetId: created.datasetId, query: "SELECT id, n" }),
      );
      expect(updated.tableId).toEqual(created.tableId);
      expect(updated.creationTime).toEqual(created.creationTime);
      expect(updated.view?.query).toMatch(/^SELECT id, n FROM /);

      const fetchedUpdate = yield* tableStatus(created.project, created.datasetId, created.tableId);
      expect(fetchedUpdate.creationTime).toEqual(created.creationTime);
      expect((fetchedUpdate.schema?.fields ?? []).map((field) => field.name)).toEqual(["id", "n"]);

      // A generated name is replaced create-before-delete, under a new name.
      const replaced = yield* stack.deploy(viewStack({ datasetId: created.datasetId }));
      expect(replaced.tableId).not.toEqual(created.tableId);
      expect(replaced.type).toEqual("TABLE");
      expect(replaced.view).toBeUndefined();

      const fetchedReplace = yield* tableStatus(
        replaced.project,
        replaced.datasetId,
        replaced.tableId,
      );
      expect(fetchedReplace.type).toEqual("TABLE");
      expect(fetchedReplace.view).toBeUndefined();

      const viewGone = yield* waitUntilGone(created.project, created.datasetId, created.tableId);
      expect(viewGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.project, replaced.datasetId, replaced.tableId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 120_000 },
);

test.provider(
  "create and update a hive-partitioned external table over Cloud Storage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const externalStack = (props: { datasetId?: string; requirePartitionFilter?: boolean }) =>
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Data", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const first = yield* GCP.Storage.Object("DayOne", {
            bucketName: bucket.bucketName,
            key: "events/day=2024-01-01/part-0.json",
            content: '{"id":"a","n":1}\n{"id":"b","n":2}\n',
            contentType: "application/json",
          });
          const second = yield* GCP.Storage.Object("DayTwo", {
            bucketName: bucket.bucketName,
            key: "events/day=2024-01-02/part-0.json",
            content: '{"id":"c","n":3}\n',
            contentType: "application/json",
          });
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            datasetId: props.datasetId,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          // Referencing both objects orders the table after its source files,
          // which autodetect reads at create time.
          const table = yield* GCP.BigQuery.Table("Events", {
            datasetId: dataset.datasetId,
            description: "daily events",
            externalDataConfiguration: {
              sourceUris: [Output.interpolate`gs://${first.bucketName}/events/*`],
              sourceFormat: "NEWLINE_DELIMITED_JSON",
              autodetect: true,
              hivePartitioningOptions: {
                mode: "CUSTOM",
                sourceUriPrefix: Output.interpolate`gs://${second.bucketName}/events/{day:DATE}`,
                requirePartitionFilter: props.requirePartitionFilter,
              },
            },
          });
          return { bucket, table };
        });

      const { bucket, table: created } = yield* stack.deploy(externalStack({}));
      expect(created.type).toEqual("EXTERNAL");
      expect(created.externalDataConfiguration).toMatchObject({
        sourceUris: [`gs://${bucket.bucketName}/events/*`],
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        hivePartitioningOptions: {
          mode: "CUSTOM",
          sourceUriPrefix: `gs://${bucket.bucketName}/events/{day:DATE}`,
          requirePartitionFilter: false,
        },
      });

      const queried = yield* bigquery.queryJobs({
        projectId: created.project,
        body: {
          query: `SELECT day, SUM(n) AS total FROM ${created.datasetId}.${created.tableId} GROUP BY day ORDER BY day`,
          useLegacySql: false,
          location: created.location,
        },
      });
      expect(queried.jobComplete).toEqual(true);
      expect((queried.rows ?? []).map((row) => row.f?.map((cell) => cell.v))).toEqual([
        ["2024-01-01", "3"],
        ["2024-01-02", "3"],
      ]);

      const { table: updated } = yield* stack.deploy(
        externalStack({ datasetId: created.datasetId, requirePartitionFilter: true }),
      );
      expect(updated.tableId).toEqual(created.tableId);
      expect(updated.creationTime).toEqual(created.creationTime);
      expect(updated.externalDataConfiguration?.hivePartitioningOptions).toMatchObject({
        requirePartitionFilter: true,
      });

      const fetchedUpdate = yield* tableStatus(created.project, created.datasetId, created.tableId);
      expect(fetchedUpdate.creationTime).toEqual(created.creationTime);
      expect(fetchedUpdate.description).toEqual("daily events");
      expect(fetchedUpdate.externalDataConfiguration).toMatchObject({
        sourceUris: [`gs://${bucket.bucketName}/events/*`],
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        hivePartitioningOptions: {
          mode: "CUSTOM",
          sourceUriPrefix: `gs://${bucket.bucketName}/events/{day:DATE}`,
          requirePartitionFilter: true,
        },
      });
      expect((fetchedUpdate.schema?.fields ?? []).map((field) => field.name)).toEqual(
        expect.arrayContaining(["id", "n", "day"]),
      );

      const filtered = yield* bigquery.queryJobs({
        projectId: created.project,
        body: {
          query: `SELECT SUM(n) AS total FROM ${created.datasetId}.${created.tableId} WHERE day = '2024-01-01'`,
          useLegacySql: false,
          location: created.location,
        },
      });
      expect((filtered.rows ?? []).map((row) => row.f?.map((cell) => cell.v))).toEqual([["3"]]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.datasetId, created.tableId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 180_000 },
);

test.provider(
  "rejects a table that is both a view and an external table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
              location: "US-CENTRAL1",
              forceDestroy: true,
            });
            return yield* GCP.BigQuery.Table("Both", {
              datasetId: dataset.datasetId,
              view: { query: "SELECT 1 AS id" },
              externalDataConfiguration: {
                sourceUris: ["gs://example-bucket/events/*"],
                sourceFormat: "NEWLINE_DELIMITED_JSON",
              },
            });
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(GCP.BigQuery.ConflictingTableKind);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 90_000 },
);
