import type * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KeyValueStore } from "./KeyValueStore.ts";

export interface ListKeysRequest extends Omit<kvs.ListKeysRequest, "KvsARN"> {}

/**
 * Runtime binding for `cloudfront-keyvaluestore:ListKeys`.
 *
 * Lists key/value pairs in the bound KeyValueStore's data plane (paginated
 * via `NextToken`/`MaxResults`). Provide the implementation with
 * `Effect.provide(AWS.CloudFront.ListKeysHttp)`.
 * @binding
 * @section Reading KeyValueStore Data
 * @example List Keys
 * ```typescript
 * // init — bind the operation to the store
 * const listKeys = yield* CloudFront.ListKeys(store);
 *
 * // runtime
 * const res = yield* listKeys({ MaxResults: 50 });
 * console.log(res.Items?.map((item) => item.Key));
 * ```
 */
export interface ListKeys extends Binding.Service<
  ListKeys,
  "AWS.CloudFront.ListKeys",
  (
    store: KeyValueStore,
  ) => Effect.Effect<
    (
      request: ListKeysRequest,
    ) => Effect.Effect<kvs.ListKeysResponse, kvs.ListKeysError>
  >
> {}

export const ListKeys = Binding.Service<ListKeys>("AWS.CloudFront.ListKeys");
