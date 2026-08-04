import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxCluster` — reads one kdb cluster of the bound environment — status, mounted databases, code configuration, and endpoints — for runtime monitoring and orchestration.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxClusterHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Check a Cluster's Status
 * ```typescript
 * const getCluster = yield* AWS.FinSpace.GetKxCluster(kdb);
 *
 * const { status } = yield* getCluster({ clusterName: "hdb" });
 * ```
 */
export interface GetKxCluster extends Binding.Service<
  GetKxCluster,
  "AWS.FinSpace.GetKxCluster",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxClusterRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxClusterResponse, SVC.GetKxClusterError>
  >
> {}
export const GetKxCluster = Binding.Service<GetKxCluster>(
  "AWS.FinSpace.GetKxCluster",
);
