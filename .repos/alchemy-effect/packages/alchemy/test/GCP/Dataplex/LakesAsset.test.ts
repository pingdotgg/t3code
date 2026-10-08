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
  dataplex.getProjectsLocationsLakesZonesAssets({ name }).pipe(
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
  "create, update, and delete a lake asset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("LandingData", {
            location: "US-CENTRAL1",
            forceDestroy: true,
            labels: { env: "test" },
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
            displayName: "landing bucket",
            labels: { env: "test" },
            resourceSpec: {
              type: "STORAGE_BUCKET",
              name: Output.interpolate`projects/${bucket.projectNumber}/buckets/${bucket.bucketName}`,
            },
            discoverySpec: { enabled: false },
          });
          return { bucket, lake, zone, asset };
        }),
      );

      expect(created.asset.name).toContain("/assets/");
      expect(created.asset.assetId).toEqual(expect.any(String));
      expect(created.asset.zone).toEqual(created.zone.name);
      expect(created.asset.resourceType).toEqual("STORAGE_BUCKET");
      expect(created.asset.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsLakesZonesAssets({
        name: created.asset.name,
      });
      expect(fetched.name).toEqual(created.asset.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.resourceSpec?.type).toEqual("STORAGE_BUCKET");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("LandingData", {
            bucketName: created.bucket.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
            labels: { env: "test" },
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
            displayName: "landing bucket b",
            description: "updated asset",
            labels: { env: "prod", team: "data" },
            resourceSpec: {
              type: "STORAGE_BUCKET",
              name: Output.interpolate`projects/${bucket.projectNumber}/buckets/${bucket.bucketName}`,
            },
            discoverySpec: { enabled: false },
          });
          return { bucket, lake, zone, asset };
        }),
      );

      expect(updated.asset.name).toEqual(created.asset.name);
      expect(updated.asset.displayName).toEqual("landing bucket b");
      expect(updated.asset.description).toEqual("updated asset");
      expect(updated.asset.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.asset.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
