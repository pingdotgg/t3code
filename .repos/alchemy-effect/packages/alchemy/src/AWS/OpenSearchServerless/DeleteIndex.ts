import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Collection } from "./Collection.ts";

/**
 * Runtime binding for the `DeleteIndex` operation scoped to one collection
 * (IAM action `aoss:APIAccessAll` on the collection ARN).
 *
 * Deletes an index from the bound {@link Collection} — the teardown half of
 * the runtime multi-tenant pattern built with {@link CreateIndex}. Deleting
 * an already-deleted index surfaces the typed `ResourceNotFoundException`.
 * The calling principal must also be granted `aoss:DeleteIndex` on the index
 * pattern by a data {@link AccessPolicy}. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.DeleteIndexHttp)`.
 * @binding
 * @section Managing Indexes at Runtime
 * @example Delete a tenant's index
 * ```typescript
 * const deleteIndex = yield* AWS.OpenSearchServerless.DeleteIndex(collection);
 *
 * yield* deleteIndex({ indexName: "tenant-42" }).pipe(
 *   Effect.catchTag("ResourceNotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeleteIndex extends Binding.Service<
  DeleteIndex,
  "AWS.OpenSearchServerless.DeleteIndex",
  (
    collection: Collection,
  ) => Effect.Effect<
    (
      request: Omit<aoss.DeleteIndexRequest, "id">,
    ) => Effect.Effect<aoss.DeleteIndexResponse, aoss.DeleteIndexError>
  >
> {}
export const DeleteIndex = Binding.Service<DeleteIndex>(
  "AWS.OpenSearchServerless.DeleteIndex",
);
