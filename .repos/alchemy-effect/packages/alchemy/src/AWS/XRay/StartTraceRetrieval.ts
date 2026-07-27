import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface StartTraceRetrievalRequest
  extends xray.StartTraceRetrievalRequest {}

/**
 * Initiate a Transaction Search trace retrieval for the given trace IDs
 * and time range, returning a `RetrievalToken` for `ListRetrievedTraces`
 * and `GetRetrievedTracesGraph`.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.StartTraceRetrievalHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:StartTraceRetrieval`, so the binding grants it on `*`.
 * @binding
 * @section Transaction Search
 * @example Start retrieving traces from Transaction Search
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:StartTraceRetrieval
 * const startTraceRetrieval = yield* XRay.StartTraceRetrieval();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const retrieval = yield* startTraceRetrieval({
 *   TraceIds: ["1-63a2090f-3f4da4bcd9b1a3e07531423b"],
 *   StartTime: new Date(now - 60 * 60 * 1000),
 *   EndTime: new Date(now),
 * });
 * const token = retrieval.RetrievalToken;
 * ```
 */
export interface StartTraceRetrieval extends Binding.Service<
  StartTraceRetrieval,
  "AWS.XRay.StartTraceRetrieval",
  () => Effect.Effect<
    (
      request: StartTraceRetrievalRequest,
    ) => Effect.Effect<
      xray.StartTraceRetrievalResult,
      xray.StartTraceRetrievalError
    >
  >
> {}
export const StartTraceRetrieval = Binding.Service<StartTraceRetrieval>(
  "AWS.XRay.StartTraceRetrieval",
);
