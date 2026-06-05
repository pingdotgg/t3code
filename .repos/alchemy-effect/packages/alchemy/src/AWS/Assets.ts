import type { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { HttpClient } from "effect/unstable/http/HttpClient";

import { lookupAssetsBucket } from "./Bootstrap.ts";

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
export type AssetsRequirements = Region | Credentials | HttpClient;

export class Assets extends Context.Service<
  Assets,
  {
    /**
     * The name of the assets bucket.
     */
    readonly bucketName: string;

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
>()("AWS::Assets") {}

/**
 * S3 key prefix for Lambda function code assets.
 */
const LAMBDA_PREFIX = "lambda";

/**
 * Generate the S3 key for a Lambda asset.
 */
const getLambdaAssetKey = (hash: string) => `${LAMBDA_PREFIX}/${hash}.zip`;

/**
 * Look up the assets bucket by scanning for the bootstrap tags.
 * Returns Option.some(bucketName) if found, Option.none() otherwise.
 */
export { lookupAssetsBucket };

/**
 * Create the Assets service implementation for a given bucket.
 */
const createAssetsService = (bucketName: string): typeof Assets.Service => ({
  bucketName,
  uploadAsset: (hash: string, content: Uint8Array) => {
    const key = getLambdaAssetKey(hash);

    return Effect.gen(function* () {
      // Check if asset already exists
      const exists = yield* s3
        .headObject({ Bucket: bucketName, Key: key })
        .pipe(
          Effect.map(() => true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );

      if (exists) {
        yield* Effect.logDebug(
          `Asset already exists: s3://${bucketName}/${key}`,
        );
        return key;
      }

      // Upload the asset
      yield* s3.putObject({
        Bucket: bucketName,
        Key: key,
        Body: content,
        ContentType: "application/zip",
      });

      yield* Effect.logDebug(`Uploaded asset: s3://${bucketName}/${key}`);
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
  hasAsset: (hash: string) => {
    const key = getLambdaAssetKey(hash);

    return s3.headObject({ Bucket: bucketName, Key: key }).pipe(
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
  },
});

/**
 * Layer that provides the Assets service.
 * Looks up the assets bucket on initialization.
 * If the bucket doesn't exist, the layer will fail - use `assetsLayerWithFallback` for graceful fallback.
 */
export const assetsLayer = Layer.effect(
  Assets,
  Effect.gen(function* () {
    const maybeBucket = yield* lookupAssetsBucket;

    if (Option.isNone(maybeBucket)) {
      return yield* Effect.fail(
        new Error(
          "Assets bucket not found. Run 'alchemy bootstrap' to create it.",
        ),
      );
    }

    return createAssetsService(maybeBucket.value);
  }),
);

/**
 * Try to create the assets layer, but don't fail if the bucket doesn't exist.
 * Returns Layer.empty if the bucket is not found.
 */
export const AssetsProvider = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const maybeBucket = yield* lookupAssetsBucket;

      if (Option.isNone(maybeBucket)) {
        yield* Effect.logDebug(
          "Assets bucket not found. Lambda will use inline ZipFile deployment.",
        );
        return Layer.empty;
      }

      return Layer.succeed(Assets, createAssetsService(maybeBucket.value));
    }),
  );
