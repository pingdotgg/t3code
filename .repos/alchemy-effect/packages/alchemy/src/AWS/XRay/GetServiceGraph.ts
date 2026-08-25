import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetServiceGraphRequest extends xray.GetServiceGraphRequest {}

/**
 * Retrieve the service graph for a time window — a document describing
 * the services processing requests and the downstream services they call.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetServiceGraphHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetServiceGraph`, so the binding grants it on `*`.
 * @binding
 * @section Service Graphs & Statistics
 * @example Fetch the last 10 minutes of the service graph
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetServiceGraph
 * const getServiceGraph = yield* XRay.GetServiceGraph();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const graph = yield* getServiceGraph({
 *   StartTime: new Date(now - 10 * 60 * 1000),
 *   EndTime: new Date(now),
 * });
 * const services = graph.Services ?? [];
 * ```
 */
export interface GetServiceGraph extends Binding.Service<
  GetServiceGraph,
  "AWS.XRay.GetServiceGraph",
  () => Effect.Effect<
    (
      request: GetServiceGraphRequest,
    ) => Effect.Effect<xray.GetServiceGraphResult, xray.GetServiceGraphError>
  >
> {}
export const GetServiceGraph = Binding.Service<GetServiceGraph>(
  "AWS.XRay.GetServiceGraph",
);
