import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsLakesZonesEntities({ name, view: "BASIC" }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// A lake (~2.5 min) plus a bucket asset (~1.5 min), then teardown of both,
// runs past 5 minutes.
test.provider.skipIf(!process.env.GCP_TEST_SLOW || !!process.env.FAST)(
  "create, update, and delete a lake entity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("EntityData", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const lake = yield* GCP.Dataplex.Lake("Warehouse", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const zone = yield* GCP.Dataplex.LakesZone("Landing", {
            lake: lake.name,
            type: "RAW",
            locationType: "SINGLE_REGION",
            discoverySpec: { enabled: false },
            labels: { env: "test" },
          });
          const asset = yield* GCP.Dataplex.LakesAsset("RawBucket", {
            zone: zone.name,
            resourceSpec: {
              type: "STORAGE_BUCKET",
              name: Output.interpolate`projects/${bucket.projectNumber}/buckets/${bucket.bucketName}`,
            },
            discoverySpec: { enabled: false },
            labels: { env: "test" },
          });
          const entity = yield* GCP.Dataplex.LakesEntity("Events", {
            zone: zone.name,
            asset: asset.assetId,
            type: "TABLE",
            system: "CLOUD_STORAGE",
            dataPath: Output.interpolate`gs://${bucket.bucketName}/events`,
            format: { format: "PARQUET" },
            displayName: "events a",
            description: "event table",
            schema: {
              userManaged: true,
              fields: [{ name: "id", type: "STRING", mode: "REQUIRED" }],
            },
          });
          return { bucket, lake, zone, asset, entity };
        }),
      );

      expect(created.entity.name).toContain("/entities/");
      expect(created.entity.entityId).toEqual(expect.any(String));
      expect(created.entity.type).toEqual("TABLE");
      expect(created.entity.system).toEqual("CLOUD_STORAGE");
      expect(created.entity.asset).toEqual(created.asset.assetId);
      expect(created.entity.description).toEqual("event table");

      const fetched = yield* dataplex.getProjectsLocationsLakesZonesEntities({
        name: created.entity.name,
        view: "FULL",
      });
      expect(fetched.name).toEqual(created.entity.name);
      expect(fetched.type).toEqual("TABLE");
      expect(fetched.description).toEqual("event table");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("EntityData", {
            bucketName: created.bucket.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const lake = yield* GCP.Dataplex.Lake("Warehouse", {
            lakeId: created.lake.lakeId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const zone = yield* GCP.Dataplex.LakesZone("Landing", {
            lake: lake.name,
            zoneId: created.zone.zoneId,
            type: "RAW",
            locationType: "SINGLE_REGION",
            discoverySpec: { enabled: false },
            labels: { env: "test" },
          });
          const asset = yield* GCP.Dataplex.LakesAsset("RawBucket", {
            zone: zone.name,
            assetId: created.asset.assetId,
            resourceSpec: {
              type: "STORAGE_BUCKET",
              name: Output.interpolate`projects/${bucket.projectNumber}/buckets/${bucket.bucketName}`,
            },
            discoverySpec: { enabled: false },
            labels: { env: "test" },
          });
          const entity = yield* GCP.Dataplex.LakesEntity("Events", {
            zone: zone.name,
            entityId: created.entity.entityId,
            asset: asset.assetId,
            type: "TABLE",
            system: "CLOUD_STORAGE",
            dataPath: Output.interpolate`gs://${bucket.bucketName}/events`,
            format: { format: "PARQUET" },
            displayName: "events b",
            description: "event table b",
            schema: {
              userManaged: true,
              fields: [
                { name: "id", type: "STRING", mode: "REQUIRED" },
                { name: "payload", type: "STRING", mode: "NULLABLE" },
              ],
            },
          });
          return { bucket, lake, zone, asset, entity };
        }),
      );

      expect(updated.entity.name).toEqual(created.entity.name);
      expect(updated.entity.displayName).toEqual("events b");
      expect(updated.entity.description).toEqual("event table b");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.entity.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
