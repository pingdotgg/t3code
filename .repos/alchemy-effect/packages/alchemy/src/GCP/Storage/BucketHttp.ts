import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import { grantOnBucket } from "./ObjectHttp.ts";
import { makeObjectMedia } from "./ObjectMedia.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { WriteBucketClient } from "./WriteBucket.ts";

/**
 * Shared HTTP scaffolding for the Storage Read/Write/ReadWrite bindings:
 * resolves the distilled operations and media endpoints once at Layer
 * construction and grants `role` on the bound bucket at deploy time.
 *
 * NOT exported from `index.ts`.
 */
export const makeStorageBucketHelpers = Effect.gen(function* () {
  const media = yield* makeObjectMedia;
  const getObject = yield* storage.getObjects;
  const listObjects = yield* storage.listObjects;
  const deleteObject = yield* storage.deleteObjects;

  const makeRead = (bucketName: Effect.Effect<string>): ReadBucketClient => ({
    head: (object) =>
      bucketName.pipe(
        Effect.flatMap((bucket) => getObject({ bucket, object })),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      ),
    get: (object, options) =>
      bucketName.pipe(
        Effect.flatMap((bucket) =>
          media.download({ bucket, object, generation: options?.generation }),
        ),
        Effect.catchTag("GCP.Storage.ObjectNotFound", () =>
          Effect.succeed(undefined),
        ),
      ),
    list: (options) =>
      bucketName.pipe(
        Effect.flatMap((bucket) => listObjects({ bucket, ...options })),
        Effect.map((page) => ({
          objects: page.items ?? [],
          prefixes: page.prefixes ?? [],
          nextPageToken: page.nextPageToken,
        })),
      ),
  });

  const makeWrite = (bucketName: Effect.Effect<string>): WriteBucketClient => ({
    put: (name, body, options) =>
      bucketName.pipe(
        Effect.flatMap((bucket) =>
          media.upload(bucket, { ...options, name, body }),
        ),
      ),
    delete: (object) =>
      bucketName.pipe(
        Effect.flatMap((bucket) => deleteObject({ bucket, object })),
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
      ),
  });

  return { makeRead, makeWrite };
});

/** Build a bucket binding that grants `role` and returns `makeClient`'s client. */
export const makeStorageBucketBinding = <Client>(options: {
  tag: string;
  role: string;
  makeClient: (
    helpers: Effect.Success<typeof makeStorageBucketHelpers>,
    bucketName: Effect.Effect<string>,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const helpers = yield* makeStorageBucketHelpers;
    return Effect.fn(function* (bucket: Bucket) {
      yield* grantOnBucket(options.tag, bucket, options.role);
      const bucketName = yield* bucket.bucketName;
      return options.makeClient(helpers, bucketName);
    });
  });
