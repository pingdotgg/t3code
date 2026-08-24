import type * as personalizeruntime from "@distilled.cloud/aws/personalize-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:GetActionRecommendations` — Returns a list of recommended actions (next best action) for a user
 * from a campaign backed by the NEXT_BEST_ACTION recipe. Campaign ARNs
 * are chosen at runtime, so the binding takes no arguments and grants
 * `personalize:GetActionRecommendations` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.GetActionRecommendationsHttp)`.
 *
 * @binding
 * @section Serving Recommendations
 * @example Recommend Actions for a User
 * ```typescript
 * // init
 * const getActionRecommendations = yield* Personalize.GetActionRecommendations();
 *
 * const { actionList } = yield* getActionRecommendations({
 *   campaignArn,
 *   userId: "user-1",
 * });
 * ```
 */
export interface GetActionRecommendations extends Binding.Service<
  GetActionRecommendations,
  "AWS.Personalize.GetActionRecommendations",
  () => Effect.Effect<
    (
      request: personalizeruntime.GetActionRecommendationsRequest,
    ) => Effect.Effect<
      personalizeruntime.GetActionRecommendationsResponse,
      personalizeruntime.GetActionRecommendationsError
    >
  >
> {}
export const GetActionRecommendations =
  Binding.Service<GetActionRecommendations>(
    "AWS.Personalize.GetActionRecommendations",
  );
