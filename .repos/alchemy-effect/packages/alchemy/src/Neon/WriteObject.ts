import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Object, ObjectDecodeError } from "./Object.ts";
import type { WriteBucketClient } from "./WriteBucket.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { StorageBindingOptions } from "./StorageBinding.ts";

export interface WriteObjectClient<T> {
  /** Serialize a typed JSON value, or upload exact bytes/text to a raw object. */
  put(
    value: [T] extends [never] ? string | Uint8Array : T,
  ): Effect.Effect<
    Effect.Success<ReturnType<WriteBucketClient["put"]>>,
    | Effect.Error<ReturnType<WriteBucketClient["put"]>>
    | Effect.Error<ReturnType<ReadBucketClient["head"]>>
    | ObjectDecodeError,
    RuntimeContext
  >;
}

/**
 * Bind an object's key and value type for writes. Declarative reconciliation
 * restores the resource's declared value; use WriteBucket for application data.
 * Managed writers request both storage:read and storage:write: write-only
 * credentials currently fail S3 authorization. These scopes cover the branch
 * lineage, not only this object's key.
 *
 * ### Typed Writes
 * **Example:** Update settings without JSON.stringify
 * ```typescript
 * const settings = yield* Neon.WriteObject(settingsObject);
 * yield* settings.put({ theme: "dark", pageSize: 50 });
 * ```
 *
 * @binding
 * @product Bucket
 */
export interface WriteObject extends Binding.Service<
  WriteObject,
  "Neon.WriteObject",
  <T>(
    object: Object<T>,
    options?: StorageBindingOptions,
  ) => Effect.Effect<WriteObjectClient<T>>
> {
  <T>(
    object: Object<T>,
    options?: StorageBindingOptions,
  ): Effect.Effect<WriteObjectClient<T>, never, WriteObject>;
}
export const WriteObject = Binding.Service<WriteObject>("Neon.WriteObject");
