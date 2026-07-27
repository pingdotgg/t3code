import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetTraceGraphRequest extends xray.GetTraceGraphRequest {}

/**
 * Retrieve a service graph scoped to specific trace IDs — the services
 * and edges the given traces traversed.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetTraceGraphHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetTraceGraph`, so the binding grants it on `*`.
 * @binding
 * @section Service Graphs & Statistics
 * @example Graph the services one trace touched
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetTraceGraph
 * const getTraceGraph = yield* XRay.GetTraceGraph();
 *
 * // runtime
 * const graph = yield* getTraceGraph({
 *   TraceIds: ["1-63a2090f-3f4da4bcd9b1a3e07531423b"],
 * });
 * const services = graph.Services ?? [];
 * ```
 */
export interface GetTraceGraph extends Binding.Service<
  GetTraceGraph,
  "AWS.XRay.GetTraceGraph",
  () => Effect.Effect<
    (
      request: GetTraceGraphRequest,
    ) => Effect.Effect<xray.GetTraceGraphResult, xray.GetTraceGraphError>
  >
> {}
export const GetTraceGraph = Binding.Service<GetTraceGraph>(
  "AWS.XRay.GetTraceGraph",
);
