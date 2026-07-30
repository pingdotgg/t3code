import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `eks:ListClusters`.
 *
 * Enumerates the EKS cluster names in the caller's account and region.
 * `eks:ListClusters` is granted on `*` — the operation is account-scoped and takes no resource.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListClustersHttp)`.
 * @binding
 * @section Discovering Clusters
 * @example List All Clusters
 * ```typescript
 * // init
 * const listClusters = yield* AWS.EKS.ListClusters();
 *
 * // runtime
 * const { clusters } = yield* listClusters();
 * ```
 */
export interface ListClusters extends Binding.Service<
  ListClusters,
  "AWS.EKS.ListClusters",
  () => Effect.Effect<
    (
      request?: eks.ListClustersRequest,
    ) => Effect.Effect<eks.ListClustersResponse, eks.ListClustersError>
  >
> {}
export const ListClusters = Binding.Service<ListClusters>(
  "AWS.EKS.ListClusters",
);
