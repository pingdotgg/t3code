import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CancelTraceRetrievalRequest
  extends xray.CancelTraceRetrievalRequest {}

/**
 * Cancel an ongoing Transaction Search trace retrieval job by its
 * `RetrievalToken`.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.CancelTraceRetrievalHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:CancelTraceRetrieval`, so the binding grants it on `*`.
 * @binding
 * @section Transaction Search
 * @example Cancel a retrieval job
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:CancelTraceRetrieval
 * const cancelTraceRetrieval = yield* XRay.CancelTraceRetrieval();
 *
 * // runtime
 * yield* cancelTraceRetrieval({ RetrievalToken: token });
 * ```
 */
export interface CancelTraceRetrieval extends Binding.Service<
  CancelTraceRetrieval,
  "AWS.XRay.CancelTraceRetrieval",
  () => Effect.Effect<
    (
      request: CancelTraceRetrievalRequest,
    ) => Effect.Effect<
      xray.CancelTraceRetrievalResult,
      xray.CancelTraceRetrievalError
    >
  >
> {}
export const CancelTraceRetrieval = Binding.Service<CancelTraceRetrieval>(
  "AWS.XRay.CancelTraceRetrieval",
);
