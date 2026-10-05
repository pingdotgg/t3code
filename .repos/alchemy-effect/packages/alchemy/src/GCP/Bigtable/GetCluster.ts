import type * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  bigtable.GetProjectsInstancesClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Bigtable `clusters.get`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link GetClusterHttp}.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.Bigtable.GetCluster(replica);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category Bigtable
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "GCP.Bigtable.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: GetClusterRequest,
    ) => Effect.Effect<
      bigtable.Cluster,
      bigtable.GetProjectsInstancesClustersError,
      RuntimeContext
    >
  >
> {}

export const GetCluster = Binding.Service<GetCluster>(
  "GCP.Bigtable.GetCluster",
);
