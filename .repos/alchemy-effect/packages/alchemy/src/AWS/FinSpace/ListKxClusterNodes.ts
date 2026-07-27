import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxClusterNodes` — lists the nodes of a kdb cluster in the bound environment — node ids, availability zones, and launch times.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxClusterNodesHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example List a Cluster's Nodes
 * ```typescript
 * const listNodes = yield* AWS.FinSpace.ListKxClusterNodes(kdb);
 *
 * const { nodes } = yield* listNodes({ clusterName: "hdb" });
 * ```
 */
export interface ListKxClusterNodes extends Binding.Service<
  ListKxClusterNodes,
  "AWS.FinSpace.ListKxClusterNodes",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.ListKxClusterNodesRequest, "environmentId">,
    ) => Effect.Effect<
      SVC.ListKxClusterNodesResponse,
      SVC.ListKxClusterNodesError
    >
  >
> {}
export const ListKxClusterNodes = Binding.Service<ListKxClusterNodes>(
  "AWS.FinSpace.ListKxClusterNodes",
);
