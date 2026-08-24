import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetInsightImpactGraphRequest
  extends xray.GetInsightImpactGraphRequest {}

/**
 * Retrieve a structural service graph filtered by insight — which
 * services the insight's anomaly impacted over a time window.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetInsightImpactGraphHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetInsightImpactGraph`, so the binding grants it on `*`.
 * @binding
 * @section Insights
 * @example Graph the services an insight impacted
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetInsightImpactGraph
 * const getInsightImpactGraph = yield* XRay.GetInsightImpactGraph();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const graph = yield* getInsightImpactGraph({
 *   InsightId: insightId,
 *   StartTime: new Date(now - 60 * 60 * 1000),
 *   EndTime: new Date(now),
 * });
 * const services = graph.Services ?? [];
 * ```
 */
export interface GetInsightImpactGraph extends Binding.Service<
  GetInsightImpactGraph,
  "AWS.XRay.GetInsightImpactGraph",
  () => Effect.Effect<
    (
      request: GetInsightImpactGraphRequest,
    ) => Effect.Effect<
      xray.GetInsightImpactGraphResult,
      xray.GetInsightImpactGraphError
    >
  >
> {}
export const GetInsightImpactGraph = Binding.Service<GetInsightImpactGraph>(
  "AWS.XRay.GetInsightImpactGraph",
);
