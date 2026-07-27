import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PutTelemetryRecordsRequest
  extends xray.PutTelemetryRecordsRequest {}

/**
 * Upload telemetry about segment transmission (received/sent/rejected
 * counts and backend connection errors) — the companion action to
 * `PutTraceSegments` used by X-Ray daemons and custom emitters.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.PutTelemetryRecordsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:PutTelemetryRecords`, so the binding grants it on `*`.
 * @binding
 * @section Writing Traces
 * @example Report segment transmission telemetry
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:PutTelemetryRecords
 * const putTelemetryRecords = yield* XRay.PutTelemetryRecords();
 *
 * // runtime
 * yield* putTelemetryRecords({
 *   TelemetryRecords: [
 *     {
 *       Timestamp: new Date(),
 *       SegmentsReceivedCount: 10,
 *       SegmentsSentCount: 10,
 *     },
 *   ],
 * });
 * ```
 */
export interface PutTelemetryRecords extends Binding.Service<
  PutTelemetryRecords,
  "AWS.XRay.PutTelemetryRecords",
  () => Effect.Effect<
    (
      request: PutTelemetryRecordsRequest,
    ) => Effect.Effect<
      xray.PutTelemetryRecordsResult,
      xray.PutTelemetryRecordsError
    >
  >
> {}
export const PutTelemetryRecords = Binding.Service<PutTelemetryRecords>(
  "AWS.XRay.PutTelemetryRecords",
);
