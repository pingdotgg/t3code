import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as biglake from "@distilled.cloud/gcp/biglake_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsCatalogsDatabasesTables on a missing table fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        biglake.getProjectsLocationsCatalogsDatabasesTables({
          name: `projects/${project}/locations/${location}/catalogs/missing/databases/missing/tables/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("BigLakeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:biglake", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a catalog database table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("HiveTable", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
        }),
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const catalog = yield* GCP.BigLake.Catalog("Lake", { location });
          const database = yield* GCP.BigLake.CatalogsDatabase("Warehouse", {
            catalog: catalog.name,
            locationUri: `gs://${bucket.bucketName}/warehouse`,
          });
          const table = yield* GCP.BigLake.CatalogsDatabasesTable("Events", {
            database: database.name,
            hiveOptions: {
              tableType: "MANAGED_TABLE",
              storageDescriptor: {
                locationUri: `gs://${bucket.bucketName}/events`,
                inputFormat: "org.apache.hadoop.mapred.SequenceFileInputFormat",
                outputFormat:
                  "org.apache.hadoop.hive.ql.io.HiveSequenceFileOutputFormat",
              },
              parameters: { owner: "analytics" },
            },
          });
          return { catalog, database, table };
        }),
      );

      expect(created.table.name).toContain("/tables/");
      expect(created.table.database).toEqual(created.database.name);
      expect(created.table.type).toEqual("HIVE");
      expect(created.table.tableType).toEqual("MANAGED_TABLE");
      expect(created.table.parameters).toMatchObject({ owner: "analytics" });
      expect(created.table.storageDescriptor?.locationUri).toEqual(
        `gs://${bucket.bucketName}/events`,
      );

      const fetched =
        yield* biglake.getProjectsLocationsCatalogsDatabasesTables({
          name: created.table.name,
        });
      expect(fetched.name).toEqual(created.table.name);
      expect(fetched.type).toEqual("HIVE");
      expect(fetched.hiveOptions?.tableType).toEqual("MANAGED_TABLE");
      expect(fetched.hiveOptions?.parameters?.owner).toEqual("analytics");
      expect(fetched.hiveOptions?.parameters?.["alchemy-id"]).toEqual(
        expect.any(String),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const catalog = yield* GCP.BigLake.Catalog("Lake", {
            catalogId: created.catalog.catalogId,
            location,
          });
          const database = yield* GCP.BigLake.CatalogsDatabase("Warehouse", {
            catalog: catalog.name,
            databaseId: created.database.databaseId,
            locationUri: `gs://${bucket.bucketName}/warehouse`,
          });
          const table = yield* GCP.BigLake.CatalogsDatabasesTable("Events", {
            database: database.name,
            tableId: created.table.tableId,
            hiveOptions: {
              tableType: "EXTERNAL_TABLE",
              storageDescriptor: {
                locationUri: `gs://${bucket.bucketName}/events-v2`,
                inputFormat: "org.apache.hadoop.mapred.SequenceFileInputFormat",
                outputFormat:
                  "org.apache.hadoop.hive.ql.io.HiveSequenceFileOutputFormat",
              },
              parameters: { owner: "data", env: "prod" },
            },
          });
          return { catalog, database, table };
        }),
      );

      expect(updated.table.name).toEqual(created.table.name);
      expect(updated.table.tableType).toEqual("EXTERNAL_TABLE");
      expect(updated.table.storageDescriptor?.locationUri).toEqual(
        `gs://${bucket.bucketName}/events-v2`,
      );
      expect(updated.table.parameters).toMatchObject({
        owner: "data",
        env: "prod",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        biglake.getProjectsLocationsCatalogsDatabasesTables({
          name: created.table.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:biglake", "live"], timeout: 120_000 },
);
