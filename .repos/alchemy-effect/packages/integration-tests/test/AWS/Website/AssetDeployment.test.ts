import * as AWS from "@alchemy.run/aws";
import { Bucket } from "@alchemy.run/aws/S3";
import { AssetDeployment } from "@alchemy.run/aws/Website/AssetDeployment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { driftOf, repairDrift, waitForDrift } from "../drift.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "list returns [] for the non-listable AssetDeployment",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(AssetDeployment);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { tags: ["provider:aws", "provider:aws:website", "live"] },
);

test.provider(
  "create, update, and delete a purged asset deployment",
  (stack) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const v1 = path.join(import.meta.dirname, "fixtures", "asset-deployment-v1");
      const v2 = path.join(import.meta.dirname, "fixtures", "asset-deployment-v2");

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("AssetBucket", {
            forceDestroy: true,
          });
          const files = yield* AssetDeployment("WebsiteFiles", {
            bucket,
            sourcePath: v1,
            prefix: "site",
            purge: true,
          });
          return { bucket, files };
        }),
      );

      expect(deployed.files.bucketName).toBe(deployed.bucket.bucketName);
      expect(deployed.files.prefix).toBe("site");
      expect(deployed.files.fileCount).toBe(3);
      expect(deployed.files.files).toEqual(["about.html", "index.html", "robots.txt"]);

      yield* assertObjectKeys(deployed.bucket.bucketName, [
        "site/about.html",
        "site/index.html",
        "site/robots.txt",
      ]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("AssetBucket", {
            forceDestroy: true,
          });
          const files = yield* AssetDeployment("WebsiteFiles", {
            bucket,
            sourcePath: v2,
            prefix: "site",
            purge: true,
          });
          return { bucket, files };
        }),
      );

      expect(updated.bucket.bucketName).toBe(deployed.bucket.bucketName);
      expect(updated.files.fileCount).toBe(3);
      expect(updated.files.files).toEqual(["extra.css", "index.html", "robots.txt"]);
      expect(updated.files.version).not.toBe(deployed.files.version);

      yield* assertObjectKeys(updated.bucket.bucketName, [
        "site/extra.css",
        "site/index.html",
        "site/robots.txt",
      ]);

      const bucketName = deployed.bucket.bucketName;
      yield* stack.destroy();
      yield* assertBucketDeleted(bucketName);
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:website", "live"],
    timeout: 120_000,
  },
);

const listObjectKeys = (bucketName: string) =>
  Effect.gen(function* () {
    const listed = yield* s3.listObjectsV2({ Bucket: bucketName });
    return (listed.Contents ?? [])
      .flatMap((object) => (object.Key !== undefined ? [object.Key] : []))
      .sort();
  });

const keysMatch = (got: string[], expected: string[]) =>
  got.length === expected.length && expected.every((key, index) => got[index] === key);

const assertObjectKeys = (bucketName: string, expected: string[]) =>
  Effect.gen(function* () {
    const keys = yield* listObjectKeys(bucketName).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("200 millis"),
        until: (got) => keysMatch(got, expected),
        times: 15,
      }),
    );
    expect(keys).toEqual(expected);
  });

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const assertBucketDeleted = (bucketName: string) =>
  s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );

// #2688: `read` must observe the uploaded objects, or an edited or deleted
// file reads as `unchanged`.
test.provider(
  "drift detects and repairs edited, deleted and stray objects",
  (stack) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const v1 = path.join(import.meta.dirname, "fixtures", "asset-deployment-v1");

      yield* stack.destroy();

      const { bucket } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DriftAssetBucket", { forceDestroy: true });
          const files = yield* AssetDeployment("DriftFiles", {
            bucket,
            sourcePath: v1,
            prefix: "site",
            purge: true,
          });
          return { bucket, files };
        }),
      );
      expect((yield* driftOf(stack, "DriftFiles"))?.action).toBe("unchanged");

      yield* s3.putObject({
        Bucket: bucket.bucketName,
        Key: "site/index.html",
        Body: "<h1>out of band</h1>",
      });
      yield* s3.deleteObject({ Bucket: bucket.bucketName, Key: "site/robots.txt" });
      yield* s3.putObject({ Bucket: bucket.bucketName, Key: "site/stray.txt", Body: "stray" });

      const drifted = yield* waitForDrift(stack, "DriftFiles", "drifted");
      expect(drifted?.attr?.objectHashes?.["robots.txt"]).toBeUndefined();
      expect(drifted?.attr?.strayKeys).toEqual(["site/stray.txt"]);

      yield* repairDrift(stack);
      expect((yield* driftOf(stack, "DriftFiles"))?.action).toBe("unchanged");
      yield* assertObjectKeys(bucket.bucketName, [
        "site/about.html",
        "site/index.html",
        "site/robots.txt",
      ]);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:s3", "provider:aws:website", "live"], timeout: 180_000 },
);
