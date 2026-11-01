import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CloudVmCluster } from "./CloudVmCluster.ts";

export interface GetCloudVmClusterRequest extends Omit<
  oracle.GetProjectsLocationsCloudVmClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `cloudVmClusters.get`.
 *
 * ### Observing VM Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetCloudVmCluster(cluster);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetCloudVmCluster extends Binding.Service<
  GetCloudVmCluster,
  "GCP.OracleDatabase.GetCloudVmCluster",
  (
    cluster: CloudVmCluster,
  ) => Effect.Effect<
    (
      request?: GetCloudVmClusterRequest,
    ) => Effect.Effect<
      oracle.CloudVmCluster,
      oracle.GetProjectsLocationsCloudVmClustersError,
      RuntimeContext
    >
  >
> {}

export const GetCloudVmCluster = Binding.Service<GetCloudVmCluster>(
  "GCP.OracleDatabase.GetCloudVmCluster",
);
