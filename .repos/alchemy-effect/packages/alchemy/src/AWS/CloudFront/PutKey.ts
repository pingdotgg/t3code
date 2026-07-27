import type * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KeyValueStore } from "./KeyValueStore.ts";

export interface PutKeyRequest extends Omit<kvs.PutKeyRequest, "KvsARN"> {}

/**
 * Runtime binding for `cloudfront-keyvaluestore:PutKey`.
 *
 * Creates or replaces a single key in the bound KeyValueStore's data plane.
 * Writes use optimistic concurrency: pass the store's current `ETag` as
 * `IfMatch` (from {@link DescribeKeyValueStore} or a previous write's
 * response). Provide the implementation with
 * `Effect.provide(AWS.CloudFront.PutKeyHttp)`.
 * @binding
 * @section Writing KeyValueStore Data
 * @example Put a Key
 * ```typescript
 * // init — bind the operations to the store
 * const describeStore = yield* CloudFront.DescribeKeyValueStore(store);
 * const putKey = yield* CloudFront.PutKey(store);
 *
 * // runtime
 * const meta = yield* describeStore({});
 * const res = yield* putKey({
 *   Key: "routes:/about",
 *   Value: "/about.html",
 *   IfMatch: meta.ETag,
 * });
 * // res.ETag is the store's new entity tag
 * ```
 */
export interface PutKey extends Binding.Service<
  PutKey,
  "AWS.CloudFront.PutKey",
  (
    store: KeyValueStore,
  ) => Effect.Effect<
    (
      request: PutKeyRequest,
    ) => Effect.Effect<kvs.PutKeyResponse, kvs.PutKeyError>
  >
> {}

export const PutKey = Binding.Service<PutKey>("AWS.CloudFront.PutKey");
