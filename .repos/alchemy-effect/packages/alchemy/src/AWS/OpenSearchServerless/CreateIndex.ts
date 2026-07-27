import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Collection } from "./Collection.ts";

/**
 * Runtime binding for the `CreateIndex` operation scoped to one collection
 * (IAM action `aoss:APIAccessAll` on the collection ARN).
 *
 * Creates an index in the bound {@link Collection} from inside a function
 * runtime — the control-plane path for the multi-tenant pattern where each
 * tenant gets its own (vector) index. The calling principal must also be
 * granted `aoss:CreateIndex` on the index pattern by a data
 * {@link AccessPolicy}. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.CreateIndexHttp)`.
 * @binding
 * @section Managing Indexes at Runtime
 * @example Create a tenant's vector index
 * ```typescript
 * // init — bind the operation to the collection
 * const createIndex = yield* AWS.OpenSearchServerless.CreateIndex(collection);
 *
 * // runtime
 * yield* createIndex({
 *   indexName: `tenant-${tenantId}`,
 *   indexSchema: {
 *     mappings: {
 *       properties: {
 *         embedding: { type: "knn_vector", dimension: 1536 },
 *       },
 *     },
 *   },
 * });
 * ```
 */
export interface CreateIndex extends Binding.Service<
  CreateIndex,
  "AWS.OpenSearchServerless.CreateIndex",
  (
    collection: Collection,
  ) => Effect.Effect<
    (
      request: Omit<aoss.CreateIndexRequest, "id">,
    ) => Effect.Effect<aoss.CreateIndexResponse, aoss.CreateIndexError>
  >
> {}
export const CreateIndex = Binding.Service<CreateIndex>(
  "AWS.OpenSearchServerless.CreateIndex",
);
