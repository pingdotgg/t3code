import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:CreateCampaign` — Deploys a trained solution version as a live campaign that serves
 * real-time recommendations — the final step of the MLOps loop.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.CreateCampaignHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Deploy a Campaign
 * ```typescript
 * // init
 * const createCampaign = yield* Personalize.CreateCampaign();
 *
 * const { campaignArn } = yield* createCampaign({
 *   name: "recommendations",
 *   solutionVersionArn,
 * });
 * ```
 */
export interface CreateCampaign extends Binding.Service<
  CreateCampaign,
  "AWS.Personalize.CreateCampaign",
  () => Effect.Effect<
    (
      request: personalize.CreateCampaignRequest,
    ) => Effect.Effect<
      personalize.CreateCampaignResponse,
      personalize.CreateCampaignError
    >
  >
> {}
export const CreateCampaign = Binding.Service<CreateCampaign>(
  "AWS.Personalize.CreateCampaign",
);
