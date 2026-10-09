import type * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  dataproc.GetProjectsRegionsClustersRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for Dataproc `clusters.get`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link GetClusterHttp}.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.Dataproc.GetCluster(cluster);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category Dataproc
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "GCP.Dataproc.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: GetClusterRequest,
    ) => Effect.Effect<
      dataproc.Cluster,
      dataproc.GetProjectsRegionsClustersError,
      RuntimeContext
    >
  >
> {}

export const GetCluster = Binding.Service<GetCluster>(
  "GCP.Dataproc.GetCluster",
);
