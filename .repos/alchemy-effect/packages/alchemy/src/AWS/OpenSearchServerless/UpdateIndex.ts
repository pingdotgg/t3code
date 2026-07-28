import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Collection } from "./Collection.ts";

/**
 * Runtime binding for the `UpdateIndex` operation scoped to one collection
 * (IAM action `aoss:APIAccessAll` on the collection ARN).
 *
 * Updates an index's schema in the bound {@link Collection} — add new fields
 * or change field mappings at runtime. The calling principal must also be
 * granted `aoss:UpdateIndex` on the index pattern by a data
 * {@link AccessPolicy}. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.UpdateIndexHttp)`.
 * @binding
 * @section Managing Indexes at Runtime
 * @example Add a field to an index
 * ```typescript
 * const updateIndex = yield* AWS.OpenSearchServerless.UpdateIndex(collection);
 *
 * yield* updateIndex({
 *   indexName: "tenant-42",
 *   indexSchema: {
 *     mappings: { properties: { title: { type: "text" } } },
 *   },
 * });
 * ```
 */
export interface UpdateIndex extends Binding.Service<
  UpdateIndex,
  "AWS.OpenSearchServerless.UpdateIndex",
  (
    collection: Collection,
  ) => Effect.Effect<
    (
      request: Omit<aoss.UpdateIndexRequest, "id">,
    ) => Effect.Effect<aoss.UpdateIndexResponse, aoss.UpdateIndexError>
  >
> {}
export const UpdateIndex = Binding.Service<UpdateIndex>(
  "AWS.OpenSearchServerless.UpdateIndex",
);
