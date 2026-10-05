import type * as container from "@distilled.cloud/gcp/container_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  container.GetProjectsLocationsClustersRequest,
  "name"
> {}

/**
 * Runtime binding for GKE `clusters.get`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link GetClusterHttp}.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.Container.GetCluster(cluster);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category Container
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "GCP.Container.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: GetClusterRequest,
    ) => Effect.Effect<
      container.Cluster,
      container.GetProjectsLocationsClustersError,
      RuntimeContext
    >
  >
> {}

export const GetCluster = Binding.Service<GetCluster>(
  "GCP.Container.GetCluster",
);
