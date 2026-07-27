import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetInsightResults`.
 *
 * Returns the aggregated results of a Security Hub insight, grouped by the insight's group-by attribute.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetInsightResultsHttp)`.
 * @binding
 * @section Working with Insights
 * @example Read Insight Results
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getInsightResults = yield* AWS.SecurityHub.GetInsightResults();
 *
 * // runtime
 * const { InsightResults } = yield* getInsightResults({
 *   InsightArn: insight.insightArn,
 * });
 * ```
 */
export interface GetInsightResults extends Binding.Service<
  GetInsightResults,
  "AWS.SecurityHub.GetInsightResults",
  () => Effect.Effect<
    (
      request: securityhub.GetInsightResultsRequest,
    ) => Effect.Effect<
      securityhub.GetInsightResultsResponse,
      securityhub.GetInsightResultsError
    >
  >
> {}
export const GetInsightResults = Binding.Service<GetInsightResults>(
  "AWS.SecurityHub.GetInsightResults",
);
