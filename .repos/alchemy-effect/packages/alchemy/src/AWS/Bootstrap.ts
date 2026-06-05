import { Region } from "@distilled.cloud/aws/Region";
import type { BucketLocationConstraint } from "@distilled.cloud/aws/s3";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { AWSEnvironment } from "./Environment.ts";

/**
 * Tag key used to identify the alchemy assets bucket.
 */
export const ASSETS_BUCKET_TAG = "alchemy::assets-bucket";

/**
 * Tag key used to scope the alchemy assets bucket to an AWS region.
 */
export const ASSETS_BUCKET_REGION_TAG = "alchemy::assets-bucket-region";

/**
 * Build an account-regional namespace bucket name.
 *
 * Account-regional buckets must follow the naming convention:
 *   `<prefix>-<accountId>-<region>-an`
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html#account-regional-gp-buckets
 */
const createAssetsBucketName = (accountId: string, region: string) =>
  `alchemy-assets-${accountId}-${region}-an`.toLowerCase();

const createAssetsBucketTags = (region: string) => [
  { Key: ASSETS_BUCKET_TAG, Value: "true" },
  { Key: ASSETS_BUCKET_REGION_TAG, Value: region },
];

const getBucketTags = (bucketName: string) =>
  s3.getBucketTagging({ Bucket: bucketName }).pipe(
    Effect.map((response) => response.TagSet ?? []),
    Effect.catchTag("NoSuchTagSet", () =>
      Effect.succeed<Array<{ Key?: string; Value?: string }>>([]),
    ),
  );

const hasAssetsBucketTag = (tags: Array<{ Key?: string; Value?: string }>) =>
  tags.some((tag) => tag.Key === ASSETS_BUCKET_TAG && tag.Value === "true");

const normalizeBucketRegion = (location: string | undefined) => {
  if (!location) {
    return "us-east-1";
  }
  if (location === "EU") {
    return "eu-west-1";
  }
  return location;
};

const bucketMatchesRegion = (
  tags: Array<{ Key?: string; Value?: string }>,
  region: string,
) => {
  const taggedRegion = tags.find(
    (tag) => tag.Key === ASSETS_BUCKET_REGION_TAG,
  )?.Value;
  return taggedRegion === undefined ? undefined : taggedRegion === region;
};

export const lookupAssetsBuckets = Effect.gen(function* () {
  const region = yield* Region;
  const buckets = (yield* s3.listBuckets({})).Buckets ?? [];
  const matchingBuckets: string[] = [];

  for (const bucket of buckets) {
    const bucketName = bucket.Name;
    if (!bucketName) {
      continue;
    }

    const tags = yield* getBucketTags(bucketName).pipe(
      Effect.catch(() =>
        Effect.succeed<Array<{ Key?: string; Value?: string }>>([]),
      ),
    );

    if (!hasAssetsBucketTag(tags)) {
      continue;
    }

    const taggedRegionMatch = bucketMatchesRegion(tags, region);
    if (taggedRegionMatch === true) {
      matchingBuckets.push(bucketName);
      continue;
    }

    if (taggedRegionMatch === false) {
      continue;
    }

    const location = yield* s3.getBucketLocation({ Bucket: bucketName }).pipe(
      Effect.map((response) =>
        normalizeBucketRegion(response.LocationConstraint),
      ),
      Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
    );

    if (location === region) {
      matchingBuckets.push(bucketName);
    }
  }

  return matchingBuckets;
});

export const lookupAssetsBucket = Effect.gen(function* () {
  const matchingBuckets = yield* lookupAssetsBuckets;
  for (const bucketName of matchingBuckets) {
    return Option.some(bucketName);
  }
  return Option.none<string>();
});

const ensureAssetsBucketTags = Effect.fn(function* (
  bucketName: string,
  region: string,
) {
  const existingTags = yield* getBucketTags(bucketName);
  const tagSet = [
    ...existingTags.filter(
      (tag) =>
        tag.Key !== ASSETS_BUCKET_TAG && tag.Key !== ASSETS_BUCKET_REGION_TAG,
    ),
    ...createAssetsBucketTags(region),
  ];

  yield* s3.putBucketTagging({
    Bucket: bucketName,
    Tagging: {
      TagSet: tagSet.map((tag) => ({
        Key: tag.Key!,
        Value: tag.Value!,
      })),
    },
  });
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

/**
 * Bootstrap the AWS environment by creating the assets bucket.
 *
 * This is idempotent - running it multiple times is safe.
 * The bucket is tagged and later discovered by tag lookup instead of by name.
 */
export const bootstrap = Effect.fn(function* () {
  const region = yield* Region;
  const existingBucket = yield* lookupAssetsBucket;

  if (Option.isSome(existingBucket)) {
    yield* ensureAssetsBucketTags(existingBucket.value, region);
    yield* Effect.logInfo(
      `Assets bucket already exists: ${existingBucket.value}`,
    );
    return { bucketName: existingBucket.value, created: false };
  }

  const { accountId } = yield* AWSEnvironment;
  const bucketName = createAssetsBucketName(accountId, region);
  yield* s3
    .createBucket({
      Bucket: bucketName,
      BucketNamespace: "account-regional",
      CreateBucketConfiguration: {
        Tags: createAssetsBucketTags(region),
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
      schedule: Schedule.exponential(100).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
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
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(10)),
        ),
      }),
    );
  }

  return {
    bucketNames,
    destroyed: bucketNames.length,
  };
});
