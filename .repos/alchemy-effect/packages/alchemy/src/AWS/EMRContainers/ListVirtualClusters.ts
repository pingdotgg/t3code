import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `emr-containers:ListVirtualClusters`.
 *
 * Enumerates the account's EMR on EKS virtual clusters, optionally filtered
 * by state, container provider, or creation time. Account-level — no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.ListVirtualClustersHttp)`.
 * @binding
 * @section Virtual Clusters
 * @example List Running Virtual Clusters
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listVirtualClusters = yield* AWS.EMRContainers.ListVirtualClusters();
 *
 * // runtime
 * const { virtualClusters } = yield* listVirtualClusters({
 *   states: ["RUNNING"],
 * });
 * yield* Effect.log(`${virtualClusters?.length ?? 0} running virtual clusters`);
 * ```
 */
export interface ListVirtualClusters extends Binding.Service<
  ListVirtualClusters,
  "AWS.EMRContainers.ListVirtualClusters",
  () => Effect.Effect<
    (
      request?: emrc.ListVirtualClustersRequest,
    ) => Effect.Effect<
      emrc.ListVirtualClustersResponse,
      emrc.ListVirtualClustersError
    >
  >
> {}
export const ListVirtualClusters = Binding.Service<ListVirtualClusters>(
  "AWS.EMRContainers.ListVirtualClusters",
);
