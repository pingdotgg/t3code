import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetTraceSummariesRequest
  extends xray.GetTraceSummariesRequest {}

/**
 * Retrieve IDs and annotations for traces available in a time frame,
 * optionally filtered by an X-Ray filter expression.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetTraceSummariesHttp)`.
 * Feed the returned trace IDs to `XRay.BatchGetTraces` to fetch the full
 * segment documents.
 *
 * X-Ray trace reads are account-scoped: IAM does not support resource-level
 * permissions for `xray:GetTraceSummaries`, so the binding grants the action
 * on `*`.
 * @binding
 * @section Reading Trace Summaries
 * @example Find recent traces from a Handler
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * export default MyFunction.make(
 *   { main: import.meta.url, url: true, tracing: "Active" },
 *   Effect.gen(function* () {
 *     // init — bind the operation (grants xray:GetTraceSummaries)
 *     const getTraceSummaries = yield* XRay.GetTraceSummaries();
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — find traces for a service in the last 5 minutes
 *         const now = yield* Effect.sync(() => Date.now());
 *         const result = yield* getTraceSummaries({
 *           StartTime: new Date(now - 5 * 60 * 1000),
 *           EndTime: new Date(now),
 *           FilterExpression: 'service("my-api")',
 *         });
 *         return yield* HttpServerResponse.json({
 *           traceIds: (result.TraceSummaries ?? []).flatMap((summary) =>
 *             summary.Id ? [summary.Id] : [],
 *           ),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(XRay.GetTraceSummariesHttp)),
 * );
 * ```
 */
export interface GetTraceSummaries extends Binding.Service<
  GetTraceSummaries,
  "AWS.XRay.GetTraceSummaries",
  () => Effect.Effect<
    (
      request: GetTraceSummariesRequest,
    ) => Effect.Effect<
      xray.GetTraceSummariesResult,
      xray.GetTraceSummariesError
    >
  >
> {}
export const GetTraceSummaries = Binding.Service<GetTraceSummaries>(
  "AWS.XRay.GetTraceSummaries",
);
