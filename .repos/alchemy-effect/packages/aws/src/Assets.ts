import type { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
export type AssetsRequirements = Region | Credentials | HttpClient | AWSEnvironment;

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
    readonly hasAsset: (hash: string) => Effect.Effect<boolean, AssetsError, AssetsRequirements>;
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
            Effect.gen(function* () {
              const environment = yield* AWSEnvironment.current;
              if (!environment.endpoint) {
                return yield* Effect.die(
                  new Error(
                    "Assets bucket not found. Run 'alchemy provider aws bootstrap' to create it.",
                  ),
                );
              }
              // Local emulator (floci/LocalStack): bootstrap transparently —
              // the bucket is free, instant, and disposable with the emulator.
              return yield* createAssetsBucket;
            }),
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
          const exists = yield* s3.headObject({ Bucket: yield* bucketName, Key: key }).pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
          );

          if (exists) {
            yield* Effect.logDebug(`Asset already exists: s3://${yield* bucketName}/${key}`);
            return key;
          }

          // Upload the asset
          yield* s3.putObject({
            Bucket: yield* bucketName,
            Key: key,
            Body: content,
            ContentType: "application/zip",
          });

          yield* Effect.logDebug(`Uploaded asset: s3://${yield* bucketName}/${key}`);
          return key;
        }).pipe(
          Effect.mapError((err): AssetsError => ({
            _tag: "AssetsUploadError",
            message: `Failed to upload asset ${key}`,
            cause: err,
          })),
        );
      },
      hasAsset: Effect.fn(function* (hash: string) {
        const key = getLambdaAssetKey(hash);

        return yield* s3.headObject({ Bucket: yield* bucketName, Key: key }).pipe(
          Effect.map(() => true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
          Effect.mapError((err): AssetsError => ({
            _tag: "AssetsCheckError",
            message: `Failed to check asset ${key}`,
            cause: err,
          })),
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
              Effect.orElseSucceed(() => false),
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

/**
 * Create the tagged assets bucket for the current account+region and wait for
 * it to be addressable. Idempotent — used by `alchemy provider aws bootstrap` and by
 * the transparent local-emulator bootstrap in {@link AssetsLive}.
 */
export const createAssetsBucket = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current;
  const bucketName = createAssetsBucketName(accountId, region);
  yield* s3
    .createBucket({
      Bucket: bucketName,
      BucketNamespace: "account-regional",
      CreateBucketConfiguration: {
        Tags: [{ Key: ASSETS_BUCKET_TAG, Value: "true" }],
        ...(region === "us-east-1"
          ? {}
          : {
              LocationConstraint: region as s3.BucketLocationConstraint,
            }),
      },
    })
    .pipe(
      Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
      Effect.retry({
        while: (e): boolean => e._tag === "OperationAborted" || e._tag === "ServiceUnavailable",
        schedule: Schedule.exponential(100),
      }),
    );

  yield* s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
  );

  yield* Effect.logInfo(`Created assets bucket: ${bucketName}`);
  return bucketName;
});

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

/** The assets bucket carries a bucket policy that is not valid JSON. */
export class AssetsBucketPolicyInvalid extends Data.TaggedError("AssetsBucketPolicyInvalid")<{
  bucketName: string;
  message: string;
}> {}

/**
 * Policy statement id granting Lambda read access to Web Function code.
 */
export const LAMBDA_WEB_CODE_ACCESS_SID = "AlchemyLambdaWebFunctionCode";

/**
 * Prepare the assets bucket to serve `AWS.Lambda.WebFunction` code. Lambda
 * reads a Web Function's deployment package from S3 itself, pinned to an
 * object version, so the bucket needs versioning and a bucket policy that
 * lets the Lambda service principal read `lambda/*` for this account's Web
 * Function revisions. Both are observed first and only written when
 * missing, so concurrent deploys converge on the same configuration.
 */
export const ensureLambdaWebCodeAccess = Effect.fn(function* (bucketName: string) {
  const { accountId } = yield* AWSEnvironment.current;

  const versioning = yield* s3.getBucketVersioning({ Bucket: bucketName });
  if (versioning.Status !== "Enabled") {
    yield* s3.putBucketVersioning({
      Bucket: bucketName,
      VersioningConfiguration: { Status: "Enabled" },
    });
  }

  const statement = {
    Sid: LAMBDA_WEB_CODE_ACCESS_SID,
    Effect: "Allow",
    Principal: { Service: "lambda.amazonaws.com" },
    Action: ["s3:GetObject", "s3:GetObjectVersion"],
    Resource: `arn:aws:s3:::${bucketName}/lambda/*`,
    Condition: {
      StringEquals: { "aws:SourceAccount": accountId },
      ArnLike: { "aws:SourceArn": `arn:aws:lambda:*:${accountId}:web-function/*/revision/*` },
    },
  };
  const observed = yield* s3.getBucketPolicy({ Bucket: bucketName }).pipe(
    Effect.map((response) => response.Policy),
    Effect.catchTag("NoSuchBucketPolicy", () => Effect.undefined),
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.undefined
        : Effect.try({
            try: () => JSON.parse(policy) as { Version?: string; Statement?: unknown[] },
            catch: (cause) => new AssetsBucketPolicyInvalid({ bucketName, message: String(cause) }),
          }),
    ),
  );
  const statements = (observed?.Statement ?? []) as Array<{ Sid?: string }>;
  const existing = statements.find((s) => s.Sid === LAMBDA_WEB_CODE_ACCESS_SID);
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(statement)) {
    return;
  }
  yield* s3.putBucketPolicy({
    Bucket: bucketName,
    Policy: JSON.stringify({
      Version: observed?.Version ?? "2012-10-17",
      Statement: [...statements.filter((s) => s.Sid !== LAMBDA_WEB_CODE_ACCESS_SID), statement],
    }),
  });
});
