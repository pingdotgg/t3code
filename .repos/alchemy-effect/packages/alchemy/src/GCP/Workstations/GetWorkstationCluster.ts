import type * as workstations from "@distilled.cloud/gcp/workstations_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { WorkstationCluster } from "./WorkstationCluster.ts";

export interface GetWorkstationClusterRequest extends Omit<
  workstations.GetProjectsLocationsWorkstationClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Workstations `workstationClusters.get`.
 *
 * Bind this operation to a {@link WorkstationCluster} in a Function/Action
 * init phase. Provide {@link GetWorkstationClusterHttp}.
 *
 * Grants `roles/workstations.viewer` on the project because workstation
 * clusters have no IAM policy of their own.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.Workstations.GetWorkstationCluster(cluster);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category Workstations
 */
export interface GetWorkstationCluster extends Binding.Service<
  GetWorkstationCluster,
  "GCP.Workstations.GetWorkstationCluster",
  (
    cluster: WorkstationCluster,
  ) => Effect.Effect<
    (
      request?: GetWorkstationClusterRequest,
    ) => Effect.Effect<
      workstations.WorkstationCluster,
      workstations.GetProjectsLocationsWorkstationClustersError,
      RuntimeContext
    >
  >
> {}

export const GetWorkstationCluster = Binding.Service<GetWorkstationCluster>(
  "GCP.Workstations.GetWorkstationCluster",
);
