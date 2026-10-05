import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { presignS3Url } from "@distilled.cloud/aws/Presign";
import * as Region from "@distilled.cloud/aws/Region";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";

export interface StorageConfig {
  /** Branch-specific, path-style S3 endpoint. */
  endpoint: string;
  /** Signing region returned by Neon. */
  region: string;
  /** Branch credential token ID, not an AWS account key. */
  accessKeyId: string;
  /** Branch credential S3 secret. */
  secretAccessKey: Redacted.Redacted<string>;
}

export class StoragePaginationError extends Data.TaggedError(
  "StoragePaginationError",
)<{ message: string }> {}
export class StorageDeleteError extends Data.TaggedError("StorageDeleteError")<{
  message: string;
}> {}

/** Internal S3 transport. Endpoint overrides retain the bucket in the request path. */
export const storageLayer = (config: StorageConfig) =>
  Layer.mergeAll(
    Endpoint.of(config.endpoint),
    Region.of(config.region as Region.RegionName),
    Layer.succeed(
      Credentials.Credentials,
      Effect.succeed({
        accessKeyId: Redacted.make(config.accessKeyId),
        secretAccessKey: config.secretAccessKey,
        sessionToken: undefined,
        region: config.region as Region.RegionName,
      }),
    ),
  );

export type StoragePutOptions = Pick<
  S3.PutObjectRequest,
  | "ContentType"
  | "CacheControl"
  | "ContentDisposition"
  | "ContentEncoding"
  | "ContentLanguage"
  | "Metadata"
>;

/** Construct clients once; no connections or disposable resources are retained. */
export const makeStorageClient = Effect.fn(function* (
  config: StorageConfig,
  bucket: string,
) {
  const http = yield* HttpClient.HttpClient;
  const layer = Layer.mergeAll(
    storageLayer(config),
    Layer.succeed(HttpClient.HttpClient, http),
  );
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(layer));
  return {
    get: (key: string) =>
      provide(S3.getObject({ Bucket: bucket, Key: key })).pipe(
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
      ),
    head: (key: string) =>
      provide(S3.headObject({ Bucket: bucket, Key: key })).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      ),
    list: (
      options: {
        prefix?: string;
        delimiter?: string;
        cursor?: string;
        limit?: number;
      } = {},
    ) =>
      provide(
        S3.listObjectsV2({
          Bucket: bucket,
          Prefix: options.prefix,
          Delimiter: options.delimiter,
          ContinuationToken: options.cursor,
          MaxKeys: options.limit,
        }),
      ),
    put: (
      key: string,
      body: string | Uint8Array,
      options: StoragePutOptions = {},
    ) =>
      provide(
        S3.putObject({ Bucket: bucket, Key: key, Body: body, ...options }),
      ),
    delete: (key: string) =>
      provide(S3.deleteObject({ Bucket: bucket, Key: key })),
    deleteMany: (keys: string[]) =>
      Effect.gen(function* () {
        const deleted: S3.DeletedObject[] = [];
        // Large Neon batches can exceed the gateway's 60-second request limit.
        for (let offset = 0; offset < keys.length; offset += 100) {
          const result = yield* provide(
            S3.deleteObjects({
              Bucket: bucket,
              Delete: {
                Objects: keys
                  .slice(offset, offset + 100)
                  .map((Key) => ({ Key })),
              },
            }),
          );
          if (result.Errors?.length)
            return yield* new StorageDeleteError({
              message: `S3 refused ${result.Errors.length} object deletions`,
            });
          deleted.push(...(result.Deleted ?? []));
        }
        return { Deleted: deleted } satisfies S3.DeleteObjectsOutput;
      }),
    createMultipartUpload: (key: string, options: StoragePutOptions = {}) =>
      provide(
        S3.createMultipartUpload({ Bucket: bucket, Key: key, ...options }),
      ),
    uploadPart: (
      key: string,
      uploadId: string,
      partNumber: number,
      body: Uint8Array,
    ) =>
      provide(
        S3.uploadPart({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
        }),
      ),
    completeMultipartUpload: (
      key: string,
      uploadId: string,
      parts: S3.CompletedPart[],
    ) =>
      provide(
        S3.completeMultipartUpload({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      ),
    abortMultipartUpload: (key: string, uploadId: string) =>
      provide(
        S3.abortMultipartUpload({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      ).pipe(Effect.catchTag("NoSuchUpload", () => Effect.void)),
    listMultipartUploads: (keyMarker?: string, uploadIdMarker?: string) =>
      provide(
        S3.listMultipartUploads({
          Bucket: bucket,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      ),
    listParts: (key: string, uploadId: string, partNumberMarker?: string) =>
      provide(
        S3.listParts({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      ),
    presign: (
      key: string,
      method: "GET" | "PUT",
      options: { expiresIn?: number; contentType?: string } = {},
    ) => provide(presignS3Url({ bucket, key, method, ...options })),
    getTags: () =>
      provide(S3.getBucketTagging({ Bucket: bucket })).pipe(
        Effect.catchTag("NoSuchTagSet", () => Effect.succeed({ TagSet: [] })),
      ),
    putTags: (tags: Record<string, string>) =>
      provide(
        S3.putBucketTagging({
          Bucket: bucket,
          Tagging: {
            TagSet: Object.entries(tags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          },
        }),
      ),
    getCors: () =>
      provide(S3.getBucketCors({ Bucket: bucket })).pipe(
        Effect.catchTag("NoSuchCORSConfiguration", () =>
          Effect.succeed({ CORSRules: [] }),
        ),
      ),
    putCors: (rules: S3.CORSRule[]) =>
      provide(
        S3.putBucketCors({
          Bucket: bucket,
          CORSConfiguration: { CORSRules: rules },
        }),
      ),
    deleteCors: () => provide(S3.deleteBucketCors({ Bucket: bucket })),
    deleteBucket: () =>
      provide(S3.deleteBucket({ Bucket: bucket })).pipe(
        Effect.catchTag("NoSuchBucket", () => Effect.void),
      ),
  };
});

export type StorageClient = Effect.Success<
  ReturnType<typeof makeStorageClient>
>;

/** Empty only this bucket and branch, checking pagination and partial failures. */
export const emptyStorageBucket = Effect.fn(function* (client: StorageClient) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = yield* client.list({ cursor, limit: 1000 });
    const keys = (page.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [object.Key],
    );
    if (keys.length) yield* client.deleteMany(keys);
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!cursor || seen.has(cursor))) {
      return yield* new StoragePaginationError({
        message: "Object listing did not advance",
      });
    }
    if (cursor) seen.add(cursor);
  } while (cursor);
  let keyMarker: string | undefined;
  let uploadMarker: string | undefined;
  const uploadsSeen = new Set<string>();
  for (;;) {
    const page = yield* client.listMultipartUploads(keyMarker, uploadMarker);
    for (const upload of page.Uploads ?? []) {
      if (upload.Key && upload.UploadId)
        yield* client.abortMultipartUpload(upload.Key, upload.UploadId);
    }
    if (!page.IsTruncated) break;
    keyMarker = page.NextKeyMarker;
    uploadMarker = page.NextUploadIdMarker;
    const marker = `${keyMarker ?? ""}/${uploadMarker ?? ""}`;
    if (!keyMarker || uploadsSeen.has(marker)) {
      return yield* new StoragePaginationError({
        message: "Multipart listing did not advance",
      });
    }
    uploadsSeen.add(marker);
  }
});
