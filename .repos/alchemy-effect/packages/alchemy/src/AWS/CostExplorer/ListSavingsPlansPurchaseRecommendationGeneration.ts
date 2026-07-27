import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListSavingsPlansPurchaseRecommendationGeneration}.
 */
export interface ListSavingsPlansPurchaseRecommendationGenerationRequest
  extends ce.ListSavingsPlansPurchaseRecommendationGenerationRequest {}

/**
 * Runtime binding for `ce:ListSavingsPlansPurchaseRecommendationGeneration`.
 *
 * List your Savings Plans recommendation generations from the past
 * 30 days with their status. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.ListSavingsPlansPurchaseRecommendationGenerationHttp)`.
 * @binding
 * @section Savings Plans
 * @example List Recent Generations
 * ```typescript
 * // init — account-level binding takes no resource
 * const listSavingsPlansPurchaseRecommendationGeneration = yield* AWS.CostExplorer.ListSavingsPlansPurchaseRecommendationGeneration();
 *
 * // runtime
 * const result = yield* listSavingsPlansPurchaseRecommendationGeneration();
 * const generations = result.GenerationSummaryList;
 * ```
 */
export interface ListSavingsPlansPurchaseRecommendationGeneration extends Binding.Service<
  ListSavingsPlansPurchaseRecommendationGeneration,
  "AWS.CostExplorer.ListSavingsPlansPurchaseRecommendationGeneration",
  () => Effect.Effect<
    (
      request?: ListSavingsPlansPurchaseRecommendationGenerationRequest,
    ) => Effect.Effect<
      ce.ListSavingsPlansPurchaseRecommendationGenerationResponse,
      ce.ListSavingsPlansPurchaseRecommendationGenerationError
    >
  >
> {}

export const ListSavingsPlansPurchaseRecommendationGeneration =
  Binding.Service<ListSavingsPlansPurchaseRecommendationGeneration>(
    "AWS.CostExplorer.ListSavingsPlansPurchaseRecommendationGeneration",
  );
