import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:DescribeCampaign` — Reads a campaign's status and the solution version it serves — used to
 * confirm a campaign update finished before switching traffic.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.DescribeCampaignHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Poll a Campaign Update
 * ```typescript
 * // init
 * const describeCampaign = yield* Personalize.DescribeCampaign();
 *
 * const { campaign } = yield* describeCampaign({ campaignArn });
 * const live = campaign?.status === "ACTIVE";
 * ```
 */
export interface DescribeCampaign extends Binding.Service<
  DescribeCampaign,
  "AWS.Personalize.DescribeCampaign",
  () => Effect.Effect<
    (
      request: personalize.DescribeCampaignRequest,
    ) => Effect.Effect<
      personalize.DescribeCampaignResponse,
      personalize.DescribeCampaignError
    >
  >
> {}
export const DescribeCampaign = Binding.Service<DescribeCampaign>(
  "AWS.Personalize.DescribeCampaign",
);
