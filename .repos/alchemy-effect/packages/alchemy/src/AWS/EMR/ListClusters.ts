import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `elasticmapreduce:ListClusters` — lists the account's EMR clusters (optionally filtered by state or creation window) — the building block of cluster-inventory automation.
 * @binding
 * @section Discovering Clusters
 * @example List Active Clusters
 * ```typescript
 * const listClusters = yield* AWS.EMR.ListClusters();
 *
 * const { Clusters } = yield* listClusters({
 *   ClusterStates: ["RUNNING", "WAITING"],
 * });
 * ```
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
export const ListClusters = Binding.Service<ListClusters>(
  "AWS.EMR.ListClusters",
);
