import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListRetrievedTracesRequest
  extends xray.ListRetrievedTracesRequest {}

/**
 * Retrieve the traces fetched by a Transaction Search retrieval job.
 * Returns an empty response until the job's `RetrievalStatus` is
 * `COMPLETE`.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.ListRetrievedTracesHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:ListRetrievedTraces`, so the binding grants it on `*`.
 * @binding
 * @section Transaction Search
 * @example Poll a retrieval job for its traces
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:ListRetrievedTraces
 * const listRetrievedTraces = yield* XRay.ListRetrievedTraces();
 *
 * // runtime
 * const result = yield* listRetrievedTraces({ RetrievalToken: token });
 * if (result.RetrievalStatus === "COMPLETE") {
 *   const traces = result.Traces ?? [];
 * }
 * ```
 */
export interface ListRetrievedTraces extends Binding.Service<
  ListRetrievedTraces,
  "AWS.XRay.ListRetrievedTraces",
  () => Effect.Effect<
    (
      request: ListRetrievedTracesRequest,
    ) => Effect.Effect<
      xray.ListRetrievedTracesResult,
      xray.ListRetrievedTracesError
    >
  >
> {}
export const ListRetrievedTraces = Binding.Service<ListRetrievedTraces>(
  "AWS.XRay.ListRetrievedTraces",
);
