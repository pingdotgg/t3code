import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as biglake from "@distilled.cloud/gcp/biglake_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsCatalogsDatabases on a missing database fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        biglake.getProjectsLocationsCatalogsDatabases({
          name: `projects/${project}/locations/${location}/catalogs/missing/databases/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("BigLakeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:biglake", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a catalog database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("HiveMeta", {
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
            parameters: { owner: "analytics" },
          });
          return { catalog, database };
        }),
      );

      expect(created.database.name).toContain("/databases/");
      expect(created.database.catalog).toEqual(created.catalog.name);
      expect(created.database.type).toEqual("HIVE");
      expect(created.database.parameters).toMatchObject({ owner: "analytics" });
      expect(created.database.locationUri).toEqual(
        `gs://${bucket.bucketName}/warehouse`,
      );

      const fetched = yield* biglake.getProjectsLocationsCatalogsDatabases({
        name: created.database.name,
      });
      expect(fetched.name).toEqual(created.database.name);
      expect(fetched.type).toEqual("HIVE");
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
            locationUri: `gs://${bucket.bucketName}/warehouse-v2`,
            parameters: { owner: "data", env: "prod" },
          });
          return { catalog, database };
        }),
      );

      expect(updated.database.name).toEqual(created.database.name);
      expect(updated.database.locationUri).toEqual(
        `gs://${bucket.bucketName}/warehouse-v2`,
      );
      expect(updated.database.parameters).toMatchObject({
        owner: "data",
        env: "prod",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        biglake.getProjectsLocationsCatalogsDatabases({
          name: created.database.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:biglake", "live"], timeout: 120_000 },
);
