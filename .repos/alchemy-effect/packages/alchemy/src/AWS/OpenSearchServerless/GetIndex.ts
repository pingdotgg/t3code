import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Collection } from "./Collection.ts";

/**
 * Runtime binding for the `GetIndex` operation scoped to one collection
 * (IAM action `aoss:APIAccessAll` on the collection ARN).
 *
 * Reads an index's schema definition from the bound {@link Collection}. A
 * missing index surfaces the typed `ResourceNotFoundException`. The calling
 * principal must also be granted `aoss:DescribeIndex` on the index pattern by
 * a data {@link AccessPolicy}. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.GetIndexHttp)`.
 * @binding
 * @section Managing Indexes at Runtime
 * @example Read an index's schema
 * ```typescript
 * const getIndex = yield* AWS.OpenSearchServerless.GetIndex(collection);
 *
 * const { indexSchema } = yield* getIndex({ indexName: "tenant-42" });
 * ```
 */
export interface GetIndex extends Binding.Service<
  GetIndex,
  "AWS.OpenSearchServerless.GetIndex",
  (
    collection: Collection,
  ) => Effect.Effect<
    (
      request: Omit<aoss.GetIndexRequest, "id">,
    ) => Effect.Effect<aoss.GetIndexResponse, aoss.GetIndexError>
  >
> {}
export const GetIndex = Binding.Service<GetIndex>(
  "AWS.OpenSearchServerless.GetIndex",
);
