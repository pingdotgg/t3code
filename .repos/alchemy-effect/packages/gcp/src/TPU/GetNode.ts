import type * as tpu from "@distilled.cloud/gcp/tpu_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Node } from "./Node.ts";

export interface GetNodeRequest extends Omit<tpu.GetProjectsLocationsNodesRequest, "name"> {}

/**
 * Runtime binding for Cloud TPU `nodes.get`.
 *
 * Bind this operation to a {@link Node} in a Function/Action init phase.
 * Provide {@link GetNodeHttp}.
 *
 * Grants `roles/tpu.viewer` on the project because Cloud TPU has no
 * resource-level IAM.
 *
 * ### Observing Nodes
 * **Example:** Read the bound node
 * ```typescript
 * const getNode = yield* GCP.TPU.GetNode(node);
 * const live = yield* getNode();
 * ```
 *
 * @binding
 * @category TPU
 */
export interface GetNode extends Binding.Service<
  GetNode,
  "GCP.TPU.GetNode",
  (
    node: Node,
  ) => Effect.Effect<
    (
      request?: GetNodeRequest,
    ) => Effect.Effect<tpu.Node, tpu.GetProjectsLocationsNodesError, RuntimeContext>
  >
> {}

export const GetNode = Binding.Service<GetNode>("GCP.TPU.GetNode");
