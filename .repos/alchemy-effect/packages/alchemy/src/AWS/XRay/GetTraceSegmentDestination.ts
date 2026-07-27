import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetTraceSegmentDestinationRequest
  extends xray.GetTraceSegmentDestinationRequest {}

/**
 * Retrieve the current destination (X-Ray or CloudWatch Logs) of data
 * sent to `PutTraceSegments` and the OTLP endpoint. Transaction Search
 * trace retrieval requires a CloudWatch Logs destination.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetTraceSegmentDestinationHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetTraceSegmentDestination`, so the binding grants it on `*`.
 * @binding
 * @section Transaction Search
 * @example Check the trace segment destination
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetTraceSegmentDestination
 * const getTraceSegmentDestination =
 *   yield* XRay.GetTraceSegmentDestination();
 *
 * // runtime
 * const destination = yield* getTraceSegmentDestination();
 * const isTransactionSearch = destination.Destination === "CloudWatchLogs";
 * ```
 */
export interface GetTraceSegmentDestination extends Binding.Service<
  GetTraceSegmentDestination,
  "AWS.XRay.GetTraceSegmentDestination",
  () => Effect.Effect<
    (
      request?: GetTraceSegmentDestinationRequest,
    ) => Effect.Effect<
      xray.GetTraceSegmentDestinationResult,
      xray.GetTraceSegmentDestinationError
    >
  >
> {}
export const GetTraceSegmentDestination =
  Binding.Service<GetTraceSegmentDestination>(
    "AWS.XRay.GetTraceSegmentDestination",
  );
