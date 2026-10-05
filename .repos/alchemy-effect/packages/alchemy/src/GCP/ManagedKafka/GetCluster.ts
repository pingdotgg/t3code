import type * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  kafka.GetProjectsLocationsClustersRequest,
  "name"
> {}

/**
 * Runtime binding for Managed Kafka `clusters.get`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link GetClusterHttp}.
 *
 * ### Observing Clusters
 * **Example:** Read the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.ManagedKafka.GetCluster(cluster);
 * const live = yield* getCluster();
 * ```
 *
 * @binding
 * @category ManagedKafka
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "GCP.ManagedKafka.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: GetClusterRequest,
    ) => Effect.Effect<
      kafka.Cluster,
      kafka.GetProjectsLocationsClustersError,
      RuntimeContext
    >
  >
> {}

export const GetCluster = Binding.Service<GetCluster>(
  "GCP.ManagedKafka.GetCluster",
);
