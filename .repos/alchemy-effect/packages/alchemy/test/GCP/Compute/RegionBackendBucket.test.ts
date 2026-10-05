import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const region = "us-central1";

const waitUntilGone = (project: string, regionName: string, name: string) =>
  compute
    .getRegionBackendBuckets({
      project,
      region: regionName,
      backendBucket: name,
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
  "create, update, and delete a region backend bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const assets = yield* GCP.Storage.Bucket("Assets", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Compute.RegionBackendBucket("Cdn", {
            region,
            bucketName: assets.bucketName,
            description: "static assets",
          });
        }),
      );

      expect(created.name).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.bucketName).toEqual(expect.any(String));
      expect(created.description).toEqual("static assets");
      expect(created.enableCdn).toEqual(false);

      const fetched = yield* compute.getRegionBackendBuckets({
        project: created.project,
        region,
        backendBucket: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.bucketName).toEqual(created.bucketName);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("static assets");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const assets = yield* GCP.Storage.Bucket("Assets", {
            bucketName: created.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Compute.RegionBackendBucket("Cdn", {
            name: created.name,
            region,
            bucketName: assets.bucketName,
            description: "cdn origin",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("cdn origin");
      expect(updated.enableCdn).toEqual(false);

      const refetched = yield* compute.getRegionBackendBuckets({
        project: updated.project,
        region,
        backendBucket: updated.name,
      });
      expect(refetched.enableCdn).toEqual(false);
      expect(refetched.description).toContain("cdn origin");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, region, created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
