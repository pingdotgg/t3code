import type * as dax from "@distilled.cloud/aws/dax";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `RebootNode` operation (IAM action
 * `dax:RebootNode`), scoped to one {@link Cluster}.
 *
 * Reboots a single node of the bound DAX cluster — restarts the DAX engine
 * process without flushing the cache contents. The node id comes from
 * `DescribeClusters` (e.g. `my-cluster-a`). Provide the implementation with
 * `Effect.provide(AWS.DAX.RebootNodeHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Reboot an Unhealthy Node
 * ```typescript
 * const rebootNode = yield* DAX.RebootNode(cluster);
 *
 * const result = yield* rebootNode({ NodeId: nodeId });
 * // result.Cluster?.Nodes → the node reports status "rebooting"
 * ```
 */
export interface RebootNode extends Binding.Service<
  RebootNode,
  "AWS.DAX.RebootNode",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<dax.RebootNodeRequest, "ClusterName">,
    ) => Effect.Effect<dax.RebootNodeResponse, dax.RebootNodeError>
  >
> {}
export const RebootNode = Binding.Service<RebootNode>("AWS.DAX.RebootNode");
