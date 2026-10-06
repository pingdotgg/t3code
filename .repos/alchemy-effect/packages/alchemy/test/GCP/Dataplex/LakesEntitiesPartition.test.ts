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
  dataplex.getProjectsLocationsLakesZonesEntitiesPartitions({ name }).pipe(
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
  "create and delete a lake entity partition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("PartitionData", {
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
            schema: {
              userManaged: true,
              fields: [{ name: "id", type: "STRING", mode: "REQUIRED" }],
              partitionFields: [{ name: "dt", type: "STRING" }],
              partitionStyle: "HIVE_COMPATIBLE",
            },
          });
          const partition = yield* GCP.Dataplex.LakesEntitiesPartition("Day", {
            entity: entity.name,
            values: ["2024-01-01"],
            location: Output.interpolate`gs://${bucket.bucketName}/events/dt=2024-01-01`,
          });
          return { bucket, lake, zone, asset, entity, partition };
        }),
      );

      expect(created.partition.name).toContain("/partitions/");
      expect(created.partition.values).toEqual(["2024-01-01"]);
      expect(created.partition.entity).toEqual(created.entity.name);
      expect(created.partition.location).toContain("dt=2024-01-01");

      const fetched =
        yield* dataplex.getProjectsLocationsLakesZonesEntitiesPartitions({
          name: created.partition.name,
        });
      expect(fetched.name).toEqual(created.partition.name);
      expect(fetched.values).toEqual(["2024-01-01"]);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.partition.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
