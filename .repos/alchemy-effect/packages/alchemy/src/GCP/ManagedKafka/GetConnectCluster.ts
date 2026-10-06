import type * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ConnectCluster } from "./ConnectCluster.ts";

export interface GetConnectClusterRequest extends Omit<
  kafka.GetProjectsLocationsConnectClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Managed Kafka `connectClusters.get`.
 *
 * Bind this operation to a {@link ConnectCluster} in a Function/Action
 * init phase. Provide {@link GetConnectClusterHttp}.
 *
 * ### Observing Connect Clusters
 * **Example:** Read the bound Connect cluster
 * ```typescript
 * const getConnect = yield* GCP.ManagedKafka.GetConnectCluster(connect);
 * const live = yield* getConnect();
 * ```
 *
 * @binding
 * @category ManagedKafka
 */
export interface GetConnectCluster extends Binding.Service<
  GetConnectCluster,
  "GCP.ManagedKafka.GetConnectCluster",
  (
    cluster: ConnectCluster,
  ) => Effect.Effect<
    (
      request?: GetConnectClusterRequest,
    ) => Effect.Effect<
      kafka.ConnectCluster,
      kafka.GetProjectsLocationsConnectClustersError,
      RuntimeContext
    >
  >
> {}

export const GetConnectCluster = Binding.Service<GetConnectCluster>(
  "GCP.ManagedKafka.GetConnectCluster",
);
