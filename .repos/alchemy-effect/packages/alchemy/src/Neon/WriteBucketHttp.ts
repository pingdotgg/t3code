import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WriteBucket, type WriteBucketClient } from "./WriteBucket.ts";
import { makeStorageBinding, storageHttpLayer } from "./StorageBinding.ts";

export const makeWriteBucketClient = (
  client: Effect.Success<
    ReturnType<Effect.Success<ReturnType<typeof makeStorageBinding>>>
  >,
): WriteBucketClient => ({
  put: client.put,
  delete: client.delete,
  deleteMany: client.deleteMany,
  createMultipartUpload: client.createMultipartUpload,
  uploadPart: client.uploadPart,
  completeMultipartUpload: client.completeMultipartUpload,
  abortMultipartUpload: client.abortMultipartUpload,
  listMultipartUploads: client.listMultipartUploads,
  listParts: client.listParts,
  presignPut: (key, options) => client.presign(key, "PUT", options),
});

/**
 * Use injected same-branch credentials, otherwise manage explicit read/write scopes.
 *
 * @layer
 * @product Bucket
 * @provides WriteBucket
 */
export const WriteBucketHttp = Layer.effect(
  WriteBucket,
  makeStorageBinding("storage:write").pipe(
    Effect.map((bind) =>
      Effect.fn(function* (...args: Parameters<typeof bind>) {
        return makeWriteBucketClient(yield* bind(...args));
      }),
    ),
  ),
).pipe(Layer.provide(storageHttpLayer));
