import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:DeleteKxClusterNode` — deletes one node of a kdb cluster in the bound environment — the scale-in primitive for node-level cluster automation.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.DeleteKxClusterNodeHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Scale In a Node
 * ```typescript
 * const deleteNode = yield* AWS.FinSpace.DeleteKxClusterNode(kdb);
 *
 * yield* deleteNode({ clusterName: "hdb", nodeId });
 * ```
 */
export interface DeleteKxClusterNode extends Binding.Service<
  DeleteKxClusterNode,
  "AWS.FinSpace.DeleteKxClusterNode",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.DeleteKxClusterNodeRequest, "environmentId">,
    ) => Effect.Effect<
      SVC.DeleteKxClusterNodeResponse,
      SVC.DeleteKxClusterNodeError
    >
  >
> {}
export const DeleteKxClusterNode = Binding.Service<DeleteKxClusterNode>(
  "AWS.FinSpace.DeleteKxClusterNode",
);
