import type * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KeyValueStore } from "./KeyValueStore.ts";

export interface UpdateKeysRequest extends Omit<
  kvs.UpdateKeysRequest,
  "KvsARN"
> {}

/**
 * Runtime binding for `cloudfront-keyvaluestore:UpdateKeys`.
 *
 * Puts and/or deletes multiple keys in the bound KeyValueStore's data plane
 * as a single all-or-nothing batch. Writes use optimistic concurrency: pass
 * the store's current `ETag` as `IfMatch` (from
 * {@link DescribeKeyValueStore} or a previous write's response). Provide the
 * implementation with `Effect.provide(AWS.CloudFront.UpdateKeysHttp)`.
 * @binding
 * @section Writing KeyValueStore Data
 * @example Batch Put + Delete
 * ```typescript
 * // init — bind the operations to the store
 * const describeStore = yield* CloudFront.DescribeKeyValueStore(store);
 * const updateKeys = yield* CloudFront.UpdateKeys(store);
 *
 * // runtime
 * const meta = yield* describeStore({});
 * yield* updateKeys({
 *   IfMatch: meta.ETag,
 *   Puts: [{ Key: "routes:/", Value: "/index.html" }],
 *   Deletes: [{ Key: "routes:/legacy" }],
 * });
 * ```
 */
export interface UpdateKeys extends Binding.Service<
  UpdateKeys,
  "AWS.CloudFront.UpdateKeys",
  (
    store: KeyValueStore,
  ) => Effect.Effect<
    (
      request: UpdateKeysRequest,
    ) => Effect.Effect<kvs.UpdateKeysResponse, kvs.UpdateKeysError>
  >
> {}

export const UpdateKeys = Binding.Service<UpdateKeys>(
  "AWS.CloudFront.UpdateKeys",
);
