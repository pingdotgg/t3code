import type * as SVC from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `elasticmapreduce:ListClusters` — lists the account's EMR clusters (optionally filtered by state or creation window) — the building block of cluster-inventory automation.
 * ### Discovering Clusters
 * **Example:** List Active Clusters
 * ```typescript
 * const listClusters = yield* AWS.EMR.ListClusters();
 *
 * const { Clusters } = yield* listClusters({
 *   ClusterStates: ["RUNNING", "WAITING"],
 * });
 * ```
 *
 * @binding
 */
export interface ListClusters extends Binding.Service<
  ListClusters,
  "AWS.EMR.ListClusters",
  () => Effect.Effect<
    (
      request?: SVC.ListClustersInput,
    ) => Effect.Effect<SVC.ListClustersOutput, SVC.ListClustersError>
  >
> {}
export const ListClusters = Binding.Service<ListClusters>("AWS.EMR.ListClusters");
