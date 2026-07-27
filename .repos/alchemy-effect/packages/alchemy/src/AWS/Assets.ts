import type { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { AWSEnvironment } from "./Environment.ts";

/**
 * Tag key used to identify the alchemy assets bucket.
 */
export const ASSETS_BUCKET_TAG = "alchemy::assets-bucket";

/**
 * Error type for Assets service operations.
 */
export type AssetsError =
  | {
      readonly _tag: "AssetsUploadError";
      readonly message: string;
      readonly cause?: unknown;
    }
  | {
      readonly _tag: "AssetsCheckError";
      readonly message: string;
      readonly cause?: unknown;
    };

/**
 * Requirements for Assets operations (S3 operations need these).
 */
export type AssetsRequirements =
  | Region
  | Credentials
  | HttpClient
  | AWSEnvironment;

export class Assets extends Context.Service<
  Assets,
  {
    /**
     * The name of the assets bucket.
     */
    readonly bucketName: Effect.Effect<string, never, AssetsRequirements>;

    /**
     * Upload an asset to the assets bucket.
     * Uses content-addressed storage: `lambda/{hash}.zip`
     *
     * @param hash - The content hash of the asset
     * @param content - The asset content (zip file)
     * @returns The S3 key where the asset was uploaded
     */
    readonly uploadAsset: (
      hash: string,
      content: Uint8Array,
    ) => Effect.Effect<string, AssetsError, AssetsRequirements>;

    /**
     * Check if an asset already exists in the assets bucket.
     *
     * @param hash - The content hash to check
     * @returns true if the asset exists
     */
    readonly hasAsset: (
      hash: string,
    ) => Effect.Effect<boolean, AssetsError, AssetsRequirements>;
  }
>()("AWS::Assets") {
  static BucketName = Assets.use((assets) => assets.bucketName);
}

/**
 * Layer that provides the Assets service.
 * Looks up the assets bucket on initialization.
 * If the bucket doesn't exist, the layer will fail - use `assetsLayerWithFallback` for graceful fallback.
 */
export const AssetsLive = Layer.effect(
  Assets,
  Effect.gen(function* () {
    const bucketName = yield* lookupAssetsBucket.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.die(
              new Error(
                "Assets bucket not found. Run 'alchemy aws bootstrap' to create it.",
              ),
            ),
          onSome: (bucketName) => Effect.succeed(bucketName),
        }),
      ),
      Effect.orDie,
      Effect.cached,
    );

    const getLambdaAssetKey = (hash: string) => `lambda/${hash}.zip`;

    return {
      bucketName,
      uploadAsset: (hash: string, content: Uint8Array) => {
        const key = getLambdaAssetKey(hash);

        return Effect.gen(function* () {
          // Check if asset already exists
          const exists = yield* s3
            .headObject({ Bucket: yield* bucketName, Key: key })
            .pipe(
              Effect.map(() => true),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
            );

          if (exists) {
            yield* Effect.logDebug(
              `Asset already exists: s3://${yield* bucketName}/${key}`,
            );
            return key;
          }

          // Upload the asset
          yield* s3.putObject({
            Bucket: yield* bucketName,
            Key: key,
            Body: content,
            ContentType: "application/zip",
          });

          yield* Effect.logDebug(
            `Uploaded asset: s3://${yield* bucketName}/${key}`,
          );
          return key;
        }).pipe(
          Effect.mapError(
            (err): AssetsError => ({
              _tag: "AssetsUploadError",
              message: `Failed to upload asset ${key}`,
              cause: err,
            }),
          ),
        );
      },
      hasAsset: Effect.fn(function* (hash: string) {
        const key = getLambdaAssetKey(hash);

        return yield* s3
          .headObject({ Bucket: yield* bucketName, Key: key })
          .pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
            Effect.mapError(
              (err): AssetsError => ({
                _tag: "AssetsCheckError",
                message: `Failed to check asset ${key}`,
                cause: err,
              }),
            ),
          );
      }),
    };
  }),
);

export const lookupAssetsBuckets = Effect.gen(function* () {
  const { region } = yield* AWSEnvironment.current;

  return yield* s3.listBuckets
    .pages({
      Prefix: "alchemy-assets-",
      BucketRegion: region,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.Buckets ?? [])),
      Stream.filterEffect((bucket) =>
        bucket.Name === undefined
          ? Effect.succeed(false)
          : getBucketTags(bucket.Name).pipe(
              Effect.map((tags) => hasAssetsBucketTag(tags)),
              Effect.catch(() => Effect.succeed(false)),
            ),
      ),
      Stream.map((bucket) => bucket.Name!),
      Stream.runCollect,
    );
});

export const lookupAssetsBucket = Effect.gen(function* () {
  const matchingBuckets = yield* lookupAssetsBuckets;
  for (const bucketName of matchingBuckets) {
    return Option.some(bucketName);
  }
  return Option.none<string>();
});

const hasAssetsBucketTag = (tags: Array<{ Key?: string; Value?: string }>) =>
  tags.some((tag) => tag.Key === ASSETS_BUCKET_TAG && tag.Value === "true");

/**
 * Build an account-regional namespace bucket name.
 *
 * Account-regional buckets must follow the naming convention:
 *   `<prefix>-<accountId>-<region>-an`
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html#account-regional-gp-buckets
 */
export const createAssetsBucketName = (accountId: string, region: string) =>
  `alchemy-assets-${accountId}-${region}-an`.toLowerCase();

const getBucketTags = (bucketName: string) =>
  s3.getBucketTagging({ Bucket: bucketName }).pipe(
    Effect.map((response) => response.TagSet ?? []),
    Effect.catchTag("NoSuchTagSet", () =>
      Effect.succeed<Array<{ Key?: string; Value?: string }>>([]),
    ),
  );

export const ensureAssetsBucketTags = Effect.fn(function* (bucketName: string) {
  const existingTags = yield* getBucketTags(bucketName);
  const tagSet = [
    ...existingTags.filter((tag) => tag.Key !== ASSETS_BUCKET_TAG),
    { Key: ASSETS_BUCKET_TAG, Value: "true" },
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
