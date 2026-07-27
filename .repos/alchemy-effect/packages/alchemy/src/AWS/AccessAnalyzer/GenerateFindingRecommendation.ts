import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `GenerateFindingRecommendation` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface GenerateFindingRecommendationRequest extends Omit<
  aa.GenerateFindingRecommendationRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:GenerateFindingRecommendation`.
 *
 * Starts generating a remediation recommendation for an unused-permissions
 * finding. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GenerateFindingRecommendationHttp)`.
 * @binding
 * @section Finding Recommendations
 * @example Generate a Recommendation
 * ```typescript
 * const generate =
 *   yield* AWS.AccessAnalyzer.GenerateFindingRecommendation(analyzer);
 * yield* generate({ id: findingId });
 * ```
 */
export interface GenerateFindingRecommendation extends Binding.Service<
  GenerateFindingRecommendation,
  "AWS.AccessAnalyzer.GenerateFindingRecommendation",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: GenerateFindingRecommendationRequest,
    ) => Effect.Effect<
      aa.GenerateFindingRecommendationResponse,
      aa.GenerateFindingRecommendationError
    >
  >
> {}

export const GenerateFindingRecommendation =
  Binding.Service<GenerateFindingRecommendation>(
    "AWS.AccessAnalyzer.GenerateFindingRecommendation",
  );
