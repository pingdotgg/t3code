import type * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KeyValueStore } from "./KeyValueStore.ts";

export interface DescribeKeyValueStoreRequest extends Omit<
  kvs.DescribeKeyValueStoreRequest,
  "KvsARN"
> {}

/**
 * Runtime binding for `cloudfront-keyvaluestore:DescribeKeyValueStore`.
 *
 * Reads the bound KeyValueStore's data-plane metadata — item count, total
 * size, and the current `ETag` that write operations ({@link PutKey},
 * {@link DeleteKey}, {@link UpdateKeys}) require as `IfMatch`. Provide the
 * implementation with `Effect.provide(AWS.CloudFront.DescribeKeyValueStoreHttp)`.
 * @binding
 * @section Reading KeyValueStore Data
 * @example Fetch the Store's ETag Before a Write
 * ```typescript
 * // init — bind the operation to the store
 * const describeStore = yield* CloudFront.DescribeKeyValueStore(store);
 *
 * // runtime
 * const meta = yield* describeStore({});
 * console.log(meta.ETag, meta.ItemCount);
 * ```
 */
export interface DescribeKeyValueStore extends Binding.Service<
  DescribeKeyValueStore,
  "AWS.CloudFront.DescribeKeyValueStore",
  (
    store: KeyValueStore,
  ) => Effect.Effect<
    (
      request: DescribeKeyValueStoreRequest,
    ) => Effect.Effect<
      kvs.DescribeKeyValueStoreResponse,
      kvs.DescribeKeyValueStoreError
    >
  >
> {}

export const DescribeKeyValueStore = Binding.Service<DescribeKeyValueStore>(
  "AWS.CloudFront.DescribeKeyValueStore",
);
