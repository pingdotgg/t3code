import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  ObjectContent,
  ObjectNotFound,
  ObjectRequestFailed,
} from "./ObjectMedia.ts";

export type { ObjectContent } from "./ObjectMedia.ts";

export interface GetObjectRequest {
  /** Object name (key). */
  object: string;
  /** Serve this generation instead of the live one. */
  generation?: string;
}

/**
 * Runtime binding that downloads an object's content from a Cloud Storage
 * {@link Bucket} (`objects.get` with `alt=media`). Grants
 * `roles/storage.objectViewer` on the bucket.
 *
 * Bind this operation to a {@link Bucket} in a Function/Action init phase.
 * Provide {@link GetObjectHttp}.
 *
 * ### Reading Objects
 * **Example:** Read an object as text
 * ```typescript
 * const getObject = yield* GCP.Storage.GetObject(bucket);
 * const { body } = yield* getObject({ object: "hello.txt" });
 * const text = new TextDecoder().decode(body);
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetObject extends Binding.Service<
  GetObject,
  "GCP.Storage.GetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRequest,
    ) => Effect.Effect<
      ObjectContent,
      ObjectNotFound | ObjectRequestFailed,
      RuntimeContext
    >
  >
> {}

export const GetObject = Binding.Service<GetObject>("GCP.Storage.GetObject");
