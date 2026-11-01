import type * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  alloydb.GetProjectsLocationsClustersRequest,
  "name"
> {}

/**
 * Runtime binding for AlloyDB `clusters.get`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link GetClusterHttp}.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.AlloyDB.GetCluster(cluster);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category AlloyDB
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "GCP.AlloyDB.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: GetClusterRequest,
    ) => Effect.Effect<
      alloydb.Cluster,
      alloydb.GetProjectsLocationsClustersError,
      RuntimeContext
    >
  >
> {}

export const GetCluster = Binding.Service<GetCluster>("GCP.AlloyDB.GetCluster");
