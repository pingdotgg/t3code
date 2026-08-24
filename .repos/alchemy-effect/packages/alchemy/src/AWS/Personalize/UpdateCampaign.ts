import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:UpdateCampaign` — Points a live campaign at a newly trained solution version (or adjusts
 * its provisioned TPS) — the deploy step of the MLOps retraining loop.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.UpdateCampaignHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Deploy a New Model Version
 * ```typescript
 * // init
 * const updateCampaign = yield* Personalize.UpdateCampaign();
 *
 * yield* updateCampaign({ campaignArn, solutionVersionArn });
 * ```
 */
export interface UpdateCampaign extends Binding.Service<
  UpdateCampaign,
  "AWS.Personalize.UpdateCampaign",
  () => Effect.Effect<
    (
      request: personalize.UpdateCampaignRequest,
    ) => Effect.Effect<
      personalize.UpdateCampaignResponse,
      personalize.UpdateCampaignError
    >
  >
> {}
export const UpdateCampaign = Binding.Service<UpdateCampaign>(
  "AWS.Personalize.UpdateCampaign",
);
