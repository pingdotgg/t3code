import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetInsightEventsRequest extends xray.GetInsightEventsRequest {}

/**
 * Retrieve the intermediate states (events) X-Ray recorded while
 * re-evaluating an insight — the insight's impact timeline.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetInsightEventsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetInsightEvents`, so the binding grants it on `*`.
 * @binding
 * @section Insights
 * @example Walk an insight's impact timeline
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetInsightEvents
 * const getInsightEvents = yield* XRay.GetInsightEvents();
 *
 * // runtime
 * const result = yield* getInsightEvents({ InsightId: insightId });
 * const timeline = result.InsightEvents ?? [];
 * ```
 */
export interface GetInsightEvents extends Binding.Service<
  GetInsightEvents,
  "AWS.XRay.GetInsightEvents",
  () => Effect.Effect<
    (
      request: GetInsightEventsRequest,
    ) => Effect.Effect<xray.GetInsightEventsResult, xray.GetInsightEventsError>
  >
> {}
export const GetInsightEvents = Binding.Service<GetInsightEvents>(
  "AWS.XRay.GetInsightEvents",
);
