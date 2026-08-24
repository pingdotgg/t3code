import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxClusters` — lists the kdb clusters of the bound environment, optionally filtered by cluster type.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxClustersHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example List HDB Clusters
 * ```typescript
 * const listClusters = yield* AWS.FinSpace.ListKxClusters(kdb);
 *
 * const { kxClusterSummaries } = yield* listClusters({ clusterType: "HDB" });
 * ```
 */
export interface ListKxClusters extends Binding.Service<
  ListKxClusters,
  "AWS.FinSpace.ListKxClusters",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxClustersRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxClustersResponse, SVC.ListKxClustersError>
  >
> {}
export const ListKxClusters = Binding.Service<ListKxClusters>(
  "AWS.FinSpace.ListKxClusters",
);
