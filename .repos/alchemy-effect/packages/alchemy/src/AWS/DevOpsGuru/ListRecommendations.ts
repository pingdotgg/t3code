import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:ListRecommendations`.
 *
 * Lists DevOps Guru's remediation recommendations for an insight — the ready-made content of an incident notification or runbook comment.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.ListRecommendationsHttp)`.
 * @binding
 * @section Events and Recommendations
 * @example List an Insight's Recommendations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listRecommendations = yield* AWS.DevOpsGuru.ListRecommendations();
 *
 * // runtime
 * const { Recommendations } = yield* listRecommendations({
 *   InsightId: insightId,
 * });
 * for (const rec of Recommendations ?? []) {
 *   yield* Effect.log(`${rec.Name}: ${rec.Description}`);
 * }
 * ```
 */
export interface ListRecommendations extends Binding.Service<
  ListRecommendations,
  "AWS.DevOpsGuru.ListRecommendations",
  () => Effect.Effect<
    (
      request: devopsguru.ListRecommendationsRequest,
    ) => Effect.Effect<
      devopsguru.ListRecommendationsResponse,
      devopsguru.ListRecommendationsError
    >
  >
> {}
export const ListRecommendations = Binding.Service<ListRecommendations>(
  "AWS.DevOpsGuru.ListRecommendations",
);
