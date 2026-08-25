import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetSavingsPlansPurchaseRecommendation}.
 */
export interface GetSavingsPlansPurchaseRecommendationRequest
  extends ce.GetSavingsPlansPurchaseRecommendationRequest {}

/**
 * Runtime binding for `ce:GetSavingsPlansPurchaseRecommendation`.
 *
 * Retrieve Savings Plans purchase recommendations. Generate a fresh
 * set first with {@link StartSavingsPlansPurchaseRecommendationGeneration}. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetSavingsPlansPurchaseRecommendationHttp)`.
 * @binding
 * @section Savings Plans
 * @example Get Savings Plans Recommendations
 * ```typescript
 * // init — account-level binding takes no resource
 * const getSavingsPlansPurchaseRecommendation = yield* AWS.CostExplorer.GetSavingsPlansPurchaseRecommendation();
 *
 * // runtime
 * const result = yield* getSavingsPlansPurchaseRecommendation({
 *   SavingsPlansType: "COMPUTE_SP",
 *   TermInYears: "ONE_YEAR",
 *   PaymentOption: "NO_UPFRONT",
 *   LookbackPeriodInDays: "THIRTY_DAYS",
 * });
 * ```
 */
export interface GetSavingsPlansPurchaseRecommendation extends Binding.Service<
  GetSavingsPlansPurchaseRecommendation,
  "AWS.CostExplorer.GetSavingsPlansPurchaseRecommendation",
  () => Effect.Effect<
    (
      request: GetSavingsPlansPurchaseRecommendationRequest,
    ) => Effect.Effect<
      ce.GetSavingsPlansPurchaseRecommendationResponse,
      ce.GetSavingsPlansPurchaseRecommendationError
    >
  >
> {}

export const GetSavingsPlansPurchaseRecommendation =
  Binding.Service<GetSavingsPlansPurchaseRecommendation>(
    "AWS.CostExplorer.GetSavingsPlansPurchaseRecommendation",
  );
