import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface GetLineageNodeRequest extends Omit<
  datazone.GetLineageNodeInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:GetLineageNode`.
 *
 * Reads a data lineage node in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetLineageNodeHttp)`.
 * @binding
 * @section Data Lineage
 * @example Read a Lineage Node
 * ```typescript
 * // init — bind the operation to the domain
 * const getLineageNode = yield* AWS.DataZone.GetLineageNode(domain);
 *
 * // runtime
 * const node = yield* getLineageNode({ identifier: nodeId });
 * ```
 */
export interface GetLineageNode extends Binding.Service<
  GetLineageNode,
  "AWS.DataZone.GetLineageNode",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetLineageNodeRequest,
    ) => Effect.Effect<
      datazone.GetLineageNodeOutput,
      datazone.GetLineageNodeError
    >
  >
> {}
export const GetLineageNode = Binding.Service<GetLineageNode>(
  "AWS.DataZone.GetLineageNode",
);
