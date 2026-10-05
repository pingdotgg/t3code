import type * as storage from "@distilled.cloud/gcp/storage_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  ObjectNotFound,
  ObjectRequestFailed,
  PutObjectContent,
} from "./ObjectMedia.ts";

/** Write-only client for one Cloud Storage bucket. */
export interface WriteBucketClient {
  /** Upload (or overwrite) an object. `ObjectNotFound` means the bucket is gone. */
  put(
    name: string,
    body: string | Uint8Array,
    options?: Omit<PutObjectContent, "name" | "body">,
  ): Effect.Effect<
    storage.Storage_Object,
    ObjectNotFound | ObjectRequestFailed,
    RuntimeContext
  >;
  /** Delete an object. Deleting a missing object succeeds. */
  delete(
    object: string,
  ): Effect.Effect<void, storage.DeleteObjectsError, RuntimeContext>;
}

/**
 * Write access to a Cloud Storage {@link Bucket}: `put`, `delete`.
 * Grants `roles/storage.objectUser` on the bucket only (overwriting needs
 * delete, which `objectCreator` lacks).
 *
 * ### Writing to a bucket
 * **Example:** Upload and delete
 * ```typescript
 * const uploads = yield* GCP.Storage.WriteBucket(bucket);
 * yield* uploads.put("hello.txt", "Hello!", { contentType: "text/plain" });
 * yield* uploads.delete("old.txt");
 * // …provided with Effect.provide(GCP.Storage.WriteBucketHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface WriteBucket extends Binding.Service<
  WriteBucket,
  "GCP.Storage.WriteBucket",
  (bucket: Bucket) => Effect.Effect<WriteBucketClient>
> {}

export const WriteBucket = Binding.Service<WriteBucket>(
  "GCP.Storage.WriteBucket",
);
