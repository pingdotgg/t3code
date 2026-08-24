import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetInsights`.
 *
 * Lists and describes Security Hub insights (saved, grouped finding queries).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetInsightsHttp)`.
 * @binding
 * @section Working with Insights
 * @example List Custom Insights
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getInsights = yield* AWS.SecurityHub.GetInsights();
 *
 * // runtime
 * const { Insights } = yield* getInsights();
 * ```
 */
export interface GetInsights extends Binding.Service<
  GetInsights,
  "AWS.SecurityHub.GetInsights",
  () => Effect.Effect<
    (
      request?: securityhub.GetInsightsRequest,
    ) => Effect.Effect<
      securityhub.GetInsightsResponse,
      securityhub.GetInsightsError
    >
  >
> {}
export const GetInsights = Binding.Service<GetInsights>(
  "AWS.SecurityHub.GetInsights",
);
