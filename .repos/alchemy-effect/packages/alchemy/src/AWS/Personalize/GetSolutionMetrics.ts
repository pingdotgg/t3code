import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:GetSolutionMetrics` — Reads the offline evaluation metrics (precision, coverage, NDCG, …)
 * of a trained solution version — used to gate deployment on model
 * quality.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.GetSolutionMetricsHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Evaluate a Trained Model
 * ```typescript
 * // init
 * const getSolutionMetrics = yield* Personalize.GetSolutionMetrics();
 *
 * const { metrics } = yield* getSolutionMetrics({ solutionVersionArn });
 * const ndcg = metrics?.["normalized_discounted_cumulative_gain_at_25"];
 * ```
 */
export interface GetSolutionMetrics extends Binding.Service<
  GetSolutionMetrics,
  "AWS.Personalize.GetSolutionMetrics",
  () => Effect.Effect<
    (
      request: personalize.GetSolutionMetricsRequest,
    ) => Effect.Effect<
      personalize.GetSolutionMetricsResponse,
      personalize.GetSolutionMetricsError
    >
  >
> {}
export const GetSolutionMetrics = Binding.Service<GetSolutionMetrics>(
  "AWS.Personalize.GetSolutionMetrics",
);
