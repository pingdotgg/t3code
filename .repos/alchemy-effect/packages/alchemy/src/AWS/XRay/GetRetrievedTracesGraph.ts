import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetRetrievedTracesGraphRequest
  extends xray.GetRetrievedTracesGraphRequest {}

/**
 * Retrieve the service graph of the traces fetched by a Transaction
 * Search retrieval job.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetRetrievedTracesGraphHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetRetrievedTracesGraph`, so the binding grants it on `*`.
 * @binding
 * @section Transaction Search
 * @example Graph a retrieval job's traces
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetRetrievedTracesGraph
 * const getRetrievedTracesGraph = yield* XRay.GetRetrievedTracesGraph();
 *
 * // runtime
 * const graph = yield* getRetrievedTracesGraph({ RetrievalToken: token });
 * const services = graph.Services ?? [];
 * ```
 */
export interface GetRetrievedTracesGraph extends Binding.Service<
  GetRetrievedTracesGraph,
  "AWS.XRay.GetRetrievedTracesGraph",
  () => Effect.Effect<
    (
      request: GetRetrievedTracesGraphRequest,
    ) => Effect.Effect<
      xray.GetRetrievedTracesGraphResult,
      xray.GetRetrievedTracesGraphError
    >
  >
> {}
export const GetRetrievedTracesGraph = Binding.Service<GetRetrievedTracesGraph>(
  "AWS.XRay.GetRetrievedTracesGraph",
);
