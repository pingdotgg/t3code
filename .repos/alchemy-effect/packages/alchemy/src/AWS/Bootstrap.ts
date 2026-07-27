import type { BucketLocationConstraint } from "@distilled.cloud/aws/s3";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import {
  ASSETS_BUCKET_TAG,
  createAssetsBucketName,
  ensureAssetsBucketTags,
  lookupAssetsBucket,
  lookupAssetsBuckets,
} from "./Assets.ts";
import { AWSEnvironment } from "./Environment.ts";

/**
 * Bootstrap the AWS environment by creating the assets bucket.
 *
 * This is idempotent - running it multiple times is safe.
 * The bucket is tagged and later discovered by tag lookup instead of by name.
 */
export const bootstrap = Effect.fn(function* () {
  const { region } = yield* AWSEnvironment.current;
  const existingBucket = yield* lookupAssetsBucket;

  if (Option.isSome(existingBucket)) {
    yield* ensureAssetsBucketTags(existingBucket.value);
    yield* Effect.logInfo(
      `Assets bucket already exists: ${existingBucket.value}`,
    );
    return { bucketName: existingBucket.value, created: false };
  }

  const { accountId } = yield* AWSEnvironment.current;
  const bucketName = createAssetsBucketName(accountId, region);
  yield* s3
    .createBucket({
      Bucket: bucketName,
      BucketNamespace: "account-regional",
      CreateBucketConfiguration: {
        Tags: [{ Key: ASSETS_BUCKET_TAG, Value: "true" }],
        ...(region === "us-east-1"
          ? {}
          : { LocationConstraint: region as BucketLocationConstraint }),
      },
    })
    .pipe(
      Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
      Effect.retry({
        while: (e) =>
          e._tag === "OperationAborted" || e._tag === "ServiceUnavailable",
        schedule: Schedule.exponential(100),
      }),
    );

  yield* s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
  );

  yield* Effect.logInfo(`Created assets bucket: ${bucketName}`);

  return { bucketName, created: true };
});

export const destroyBootstrap = Effect.fn(function* () {
  const bucketNames = yield* lookupAssetsBuckets;

  for (const bucketName of bucketNames) {
    yield* Effect.logInfo(`Destroying assets bucket: ${bucketName}`);
    yield* deleteAllObjects(bucketName);
    yield* s3.deleteBucket({ Bucket: bucketName }).pipe(
      Effect.retry({
        while: (e) =>
          e._tag === "OperationAborted" || e._tag === "ServiceUnavailable",
        schedule: Schedule.max([
          Schedule.exponential(100),
          Schedule.recurs(10),
        ]),
      }),
    );
  }

  return {
    bucketNames,
    destroyed: bucketNames.length,
  };
});

const deleteAllObjects = Effect.fn(function* (bucketName: string) {
  let continuationToken: string | undefined;
  do {
    const listResponse = yield* s3.listObjectsV2({
      Bucket: bucketName,
      ContinuationToken: continuationToken,
    });

    if (listResponse.Contents && listResponse.Contents.length > 0) {
      yield* s3.deleteObjects({
        Bucket: bucketName,
        Delete: {
          Objects: listResponse.Contents.map((obj) => ({
            Key: obj.Key!,
          })),
          Quiet: true,
        },
      });
    }

    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const listVersionsResponse = yield* s3.listObjectVersions({
      Bucket: bucketName,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    });

    const objectsToDelete = [
      ...(listVersionsResponse.Versions ?? []).map((v) => ({
        Key: v.Key!,
        VersionId: v.VersionId,
      })),
      ...(listVersionsResponse.DeleteMarkers ?? []).map((dm) => ({
        Key: dm.Key!,
        VersionId: dm.VersionId,
      })),
    ];

    if (objectsToDelete.length > 0) {
      yield* s3.deleteObjects({
        Bucket: bucketName,
        Delete: {
          Objects: objectsToDelete,
          Quiet: true,
        },
      });
    }

    keyMarker = listVersionsResponse.NextKeyMarker;
    versionIdMarker = listVersionsResponse.NextVersionIdMarker;
  } while (keyMarker);
});
