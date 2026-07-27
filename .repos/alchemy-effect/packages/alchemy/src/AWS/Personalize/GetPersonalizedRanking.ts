import type * as personalizeruntime from "@distilled.cloud/aws/personalize-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:GetPersonalizedRanking` — Re-ranks a caller-supplied list of items for a user using a campaign
 * backed by the Personalized-Ranking recipe. Campaign ARNs are chosen at
 * runtime, so the binding takes no arguments and grants
 * `personalize:GetPersonalizedRanking` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.GetPersonalizedRankingHttp)`.
 *
 * @binding
 * @section Serving Recommendations
 * @example Rank Items for a User
 * ```typescript
 * // init
 * const getPersonalizedRanking = yield* Personalize.GetPersonalizedRanking();
 *
 * const { personalizedRanking } = yield* getPersonalizedRanking({
 *   campaignArn,
 *   userId: "user-1",
 *   inputList: ["item-1", "item-2", "item-3"],
 * });
 * ```
 */
export interface GetPersonalizedRanking extends Binding.Service<
  GetPersonalizedRanking,
  "AWS.Personalize.GetPersonalizedRanking",
  () => Effect.Effect<
    (
      request: personalizeruntime.GetPersonalizedRankingRequest,
    ) => Effect.Effect<
      personalizeruntime.GetPersonalizedRankingResponse,
      personalizeruntime.GetPersonalizedRankingError
    >
  >
> {}
export const GetPersonalizedRanking = Binding.Service<GetPersonalizedRanking>(
  "AWS.Personalize.GetPersonalizedRanking",
);
