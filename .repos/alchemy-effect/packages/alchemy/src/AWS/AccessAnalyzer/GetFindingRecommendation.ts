import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `GetFindingRecommendation` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface GetFindingRecommendationRequest extends Omit<
  aa.GetFindingRecommendationRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:GetFindingRecommendation`.
 *
 * Retrieves the generated remediation recommendation for an unused-permissions
 * finding. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GetFindingRecommendationHttp)`.
 * @binding
 * @section Finding Recommendations
 * @example Read a Recommendation
 * ```typescript
 * const getRecommendation =
 *   yield* AWS.AccessAnalyzer.GetFindingRecommendation(analyzer);
 * const recommendation = yield* getRecommendation({ id: findingId });
 * ```
 */
export interface GetFindingRecommendation extends Binding.Service<
  GetFindingRecommendation,
  "AWS.AccessAnalyzer.GetFindingRecommendation",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: GetFindingRecommendationRequest,
    ) => Effect.Effect<
      aa.GetFindingRecommendationResponse,
      aa.GetFindingRecommendationError
    >
  >
> {}

export const GetFindingRecommendation =
  Binding.Service<GetFindingRecommendation>(
    "AWS.AccessAnalyzer.GetFindingRecommendation",
  );
