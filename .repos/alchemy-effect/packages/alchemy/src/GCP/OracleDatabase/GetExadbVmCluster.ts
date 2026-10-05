import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ExadbVmCluster } from "./ExadbVmCluster.ts";

export interface GetExadbVmClusterRequest extends Omit<
  oracle.GetProjectsLocationsExadbVmClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `exadbVmClusters.get`.
 *
 * ### Observing Exadb VM Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetExadbVmCluster(cluster);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetExadbVmCluster extends Binding.Service<
  GetExadbVmCluster,
  "GCP.OracleDatabase.GetExadbVmCluster",
  (
    cluster: ExadbVmCluster,
  ) => Effect.Effect<
    (
      request?: GetExadbVmClusterRequest,
    ) => Effect.Effect<
      oracle.ExadbVmCluster,
      oracle.GetProjectsLocationsExadbVmClustersError,
      RuntimeContext
    >
  >
> {}

export const GetExadbVmCluster = Binding.Service<GetExadbVmCluster>(
  "GCP.OracleDatabase.GetExadbVmCluster",
);
