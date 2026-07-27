import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetInsightRequest extends xray.GetInsightRequest {}

/**
 * Retrieve the summary information of an X-Ray insight — the anomaly
 * details X-Ray detected for a group with insights enabled.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetInsightHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetInsight`, so the binding grants it on `*`.
 * @binding
 * @section Insights
 * @example Fetch an insight by id
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetInsight
 * const getInsight = yield* XRay.GetInsight();
 *
 * // runtime
 * const result = yield* getInsight({ InsightId: insightId });
 * const state = result.Insight?.State;
 * ```
 */
export interface GetInsight extends Binding.Service<
  GetInsight,
  "AWS.XRay.GetInsight",
  () => Effect.Effect<
    (
      request: GetInsightRequest,
    ) => Effect.Effect<xray.GetInsightResult, xray.GetInsightError>
  >
> {}
export const GetInsight = Binding.Service<GetInsight>("AWS.XRay.GetInsight");
