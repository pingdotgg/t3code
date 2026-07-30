import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetSavingsPlanPurchaseRecommendationDetails}.
 */
export interface GetSavingsPlanPurchaseRecommendationDetailsRequest
  extends ce.GetSavingsPlanPurchaseRecommendationDetailsRequest {}

/**
 * Runtime binding for `ce:GetSavingsPlanPurchaseRecommendationDetails`.
 *
 * Retrieve the hourly data points behind one Savings Plans
 * recommendation — the cost, coverage, and utilization charts. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetSavingsPlanPurchaseRecommendationDetailsHttp)`.
 * @binding
 * @section Savings Plans
 * @example Read One Recommendation's Details
 * ```typescript
 * // init — account-level binding takes no resource
 * const getSavingsPlanPurchaseRecommendationDetails = yield* AWS.CostExplorer.GetSavingsPlanPurchaseRecommendationDetails();
 *
 * // runtime
 * const result = yield* getSavingsPlanPurchaseRecommendationDetails({
 *   RecommendationDetailId: detailId,
 * });
 * ```
 */
export interface GetSavingsPlanPurchaseRecommendationDetails extends Binding.Service<
  GetSavingsPlanPurchaseRecommendationDetails,
  "AWS.CostExplorer.GetSavingsPlanPurchaseRecommendationDetails",
  () => Effect.Effect<
    (
      request: GetSavingsPlanPurchaseRecommendationDetailsRequest,
    ) => Effect.Effect<
      ce.GetSavingsPlanPurchaseRecommendationDetailsResponse,
      ce.GetSavingsPlanPurchaseRecommendationDetailsError
    >
  >
> {}

export const GetSavingsPlanPurchaseRecommendationDetails =
  Binding.Service<GetSavingsPlanPurchaseRecommendationDetails>(
    "AWS.CostExplorer.GetSavingsPlanPurchaseRecommendationDetails",
  );
