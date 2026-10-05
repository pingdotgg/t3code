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

export type PutObjectRequest = PutObjectContent;

/**
 * Runtime binding that uploads an object's content to a Cloud Storage
 * {@link Bucket} (multipart `objects.insert`), overwriting any live object
 * with the same name. Grants `roles/storage.objectUser` on the bucket
 * (overwrite needs delete permission, which `objectCreator` lacks).
 *
 * Bind this operation to a {@link Bucket} in a Function/Action init phase.
 * Provide {@link PutObjectHttp}.
 *
 * ### Writing Objects
 * **Example:** Write a text object
 * ```typescript
 * const putObject = yield* GCP.Storage.PutObject(bucket);
 * yield* putObject({ name: "hello.txt", body: "Hello, World!" });
 * ```
 *
 * **Example:** Write bytes with metadata
 * ```typescript
 * yield* putObject({
 *   name: "report.json",
 *   body: new TextEncoder().encode(JSON.stringify(report)),
 *   contentType: "application/json",
 *   metadata: { source: "nightly" },
 * });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface PutObject extends Binding.Service<
  PutObject,
  "GCP.Storage.PutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectRequest,
    ) => Effect.Effect<
      storage.Storage_Object,
      ObjectNotFound | ObjectRequestFailed,
      RuntimeContext
    >
  >
> {}

export const PutObject = Binding.Service<PutObject>("GCP.Storage.PutObject");
