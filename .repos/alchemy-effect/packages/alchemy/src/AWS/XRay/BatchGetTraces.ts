import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface BatchGetTracesRequest extends xray.BatchGetTracesRequest {}

/**
 * Retrieve full traces (all segment documents) for a list of trace IDs
 * returned by `GetTraceSummaries`.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.BatchGetTracesHttp)`.
 *
 * X-Ray trace reads are account-scoped: IAM does not support resource-level
 * permissions for `xray:BatchGetTraces`, so the binding grants the action on
 * `*`.
 * @binding
 * @section Reading Traces
 * @example Fetch full traces from a Handler
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * export default MyFunction.make(
 *   { main: import.meta.url, url: true, tracing: "Active" },
 *   Effect.gen(function* () {
 *     // init — bind the operation (grants xray:BatchGetTraces)
 *     const batchGetTraces = yield* XRay.BatchGetTraces();
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — fetch full segment documents by trace ID
 *         const result = yield* batchGetTraces({
 *           TraceIds: ["1-63a2090f-3f4da4bcd9b1a3e07531423b"],
 *         });
 *         return yield* HttpServerResponse.json({
 *           segments: result.Traces?.[0]?.Segments?.length ?? 0,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(XRay.BatchGetTracesHttp)),
 * );
 * ```
 */
export interface BatchGetTraces extends Binding.Service<
  BatchGetTraces,
  "AWS.XRay.BatchGetTraces",
  () => Effect.Effect<
    (
      request: BatchGetTracesRequest,
    ) => Effect.Effect<xray.BatchGetTracesResult, xray.BatchGetTracesError>
  >
> {}
export const BatchGetTraces = Binding.Service<BatchGetTraces>(
  "AWS.XRay.BatchGetTraces",
);
