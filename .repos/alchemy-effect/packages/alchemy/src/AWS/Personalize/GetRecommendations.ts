import type * as personalizeruntime from "@distilled.cloud/aws/personalize-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:GetRecommendations` — Returns a list of recommended items for a user from a campaign or
 * domain recommender — the core Personalize serving call. Campaign and
 * recommender ARNs are chosen at runtime, so the binding takes no
 * arguments and grants `personalize:GetRecommendations` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.GetRecommendationsHttp)`.
 *
 * @binding
 * @section Serving Recommendations
 * @example Recommend Items for a User
 * ```typescript
 * // init
 * const getRecommendations = yield* Personalize.GetRecommendations();
 *
 * const { itemList } = yield* getRecommendations({
 *   campaignArn,
 *   userId: "user-1",
 *   numResults: 10,
 * });
 * ```
 */
export interface GetRecommendations extends Binding.Service<
  GetRecommendations,
  "AWS.Personalize.GetRecommendations",
  () => Effect.Effect<
    (
      request: personalizeruntime.GetRecommendationsRequest,
    ) => Effect.Effect<
      personalizeruntime.GetRecommendationsResponse,
      personalizeruntime.GetRecommendationsError
    >
  >
> {}
export const GetRecommendations = Binding.Service<GetRecommendations>(
  "AWS.Personalize.GetRecommendations",
);
