import type * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KeyValueStore } from "./KeyValueStore.ts";

export interface DeleteKeyRequest extends Omit<
  kvs.DeleteKeyRequest,
  "KvsARN"
> {}

/**
 * Runtime binding for `cloudfront-keyvaluestore:DeleteKey`.
 *
 * Deletes a single key from the bound KeyValueStore's data plane. Writes use
 * optimistic concurrency: pass the store's current `ETag` as `IfMatch` (from
 * {@link DescribeKeyValueStore} or a previous write's response). Provide the
 * implementation with `Effect.provide(AWS.CloudFront.DeleteKeyHttp)`.
 * @binding
 * @section Writing KeyValueStore Data
 * @example Delete a Key
 * ```typescript
 * // init — bind the operations to the store
 * const describeStore = yield* CloudFront.DescribeKeyValueStore(store);
 * const deleteKey = yield* CloudFront.DeleteKey(store);
 *
 * // runtime
 * const meta = yield* describeStore({});
 * yield* deleteKey({ Key: "routes:/about", IfMatch: meta.ETag });
 * ```
 */
export interface DeleteKey extends Binding.Service<
  DeleteKey,
  "AWS.CloudFront.DeleteKey",
  (
    store: KeyValueStore,
  ) => Effect.Effect<
    (
      request: DeleteKeyRequest,
    ) => Effect.Effect<kvs.DeleteKeyResponse, kvs.DeleteKeyError>
  >
> {}

export const DeleteKey = Binding.Service<DeleteKey>("AWS.CloudFront.DeleteKey");
