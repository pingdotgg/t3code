import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PutTraceSegmentsRequest extends xray.PutTraceSegmentsRequest {}

/**
 * Upload segment documents to X-Ray — custom instrumentation for work
 * the X-Ray SDK does not capture (background jobs, fan-out steps,
 * external calls).
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.PutTraceSegmentsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:PutTraceSegments`, so the binding grants it on `*`.
 * @binding
 * @section Writing Traces
 * @example Upload a custom segment
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:PutTraceSegments
 * const putTraceSegments = yield* XRay.PutTraceSegments();
 *
 * // runtime — record a completed unit of work as its own segment
 * const result = yield* putTraceSegments({
 *   TraceSegmentDocuments: [
 *     JSON.stringify({
 *       name: "nightly-import",
 *       id: "70de5b6f19ff9a0a",
 *       trace_id: "1-63a2090f-3f4da4bcd9b1a3e07531423b",
 *       start_time: 1672000000.0,
 *       end_time: 1672000000.5,
 *     }),
 *   ],
 * });
 * const failed = result.UnprocessedTraceSegments ?? [];
 * ```
 */
export interface PutTraceSegments extends Binding.Service<
  PutTraceSegments,
  "AWS.XRay.PutTraceSegments",
  () => Effect.Effect<
    (
      request: PutTraceSegmentsRequest,
    ) => Effect.Effect<xray.PutTraceSegmentsResult, xray.PutTraceSegmentsError>
  >
> {}
export const PutTraceSegments = Binding.Service<PutTraceSegments>(
  "AWS.XRay.PutTraceSegments",
);
