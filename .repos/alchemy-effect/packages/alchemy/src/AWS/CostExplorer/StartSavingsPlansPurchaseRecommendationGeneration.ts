import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link StartSavingsPlansPurchaseRecommendationGeneration}.
 */
export interface StartSavingsPlansPurchaseRecommendationGenerationRequest
  extends ce.StartSavingsPlansPurchaseRecommendationGenerationRequest {}

/**
 * Runtime binding for `ce:StartSavingsPlansPurchaseRecommendationGeneration`.
 *
 * Request a fresh Savings Plans recommendation generation based on
 * your latest usage (limited to one generation per day). Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.StartSavingsPlansPurchaseRecommendationGenerationHttp)`.
 * @binding
 * @section Savings Plans
 * @example Refresh the Recommendations
 * ```typescript
 * // init — account-level binding takes no resource
 * const startSavingsPlansPurchaseRecommendationGeneration = yield* AWS.CostExplorer.StartSavingsPlansPurchaseRecommendationGeneration();
 *
 * // runtime
 * const result = yield* startSavingsPlansPurchaseRecommendationGeneration();
 * const generationId = result.RecommendationId;
 * ```
 */
export interface StartSavingsPlansPurchaseRecommendationGeneration extends Binding.Service<
  StartSavingsPlansPurchaseRecommendationGeneration,
  "AWS.CostExplorer.StartSavingsPlansPurchaseRecommendationGeneration",
  () => Effect.Effect<
    (
      request?: StartSavingsPlansPurchaseRecommendationGenerationRequest,
    ) => Effect.Effect<
      ce.StartSavingsPlansPurchaseRecommendationGenerationResponse,
      ce.StartSavingsPlansPurchaseRecommendationGenerationError
    >
  >
> {}

export const StartSavingsPlansPurchaseRecommendationGeneration =
  Binding.Service<StartSavingsPlansPurchaseRecommendationGeneration>(
    "AWS.CostExplorer.StartSavingsPlansPurchaseRecommendationGeneration",
  );
