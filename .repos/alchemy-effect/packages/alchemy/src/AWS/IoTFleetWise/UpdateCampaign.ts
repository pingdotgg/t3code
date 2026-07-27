import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Campaign } from "./Campaign.ts";

/**
 * `UpdateCampaign` request with `name` injected from the bound campaign.
 */
export interface UpdateCampaignRequest extends Omit<
  iotfleetwise.UpdateCampaignRequest,
  "name"
> {}

/**
 * Runtime binding for the `UpdateCampaign` operation (IAM action
 * `iotfleetwise:UpdateCampaign`), scoped to one {@link Campaign}.
 *
 * Approves, suspends, or resumes the bound campaign at runtime — e.g. an
 * operations Lambda pausing data collection during an incident. Provide
 * the implementation with
 * `Effect.provide(AWS.IoTFleetWise.UpdateCampaignHttp)`.
 *
 * @binding
 * @section Campaign Control
 * @example Suspend and Resume a Campaign
 * ```typescript
 * const updateCampaign = yield* IoTFleetWise.UpdateCampaign(campaign);
 *
 * yield* updateCampaign({ action: "SUSPEND" });
 * yield* updateCampaign({ action: "RESUME" });
 * ```
 */
export interface UpdateCampaign extends Binding.Service<
  UpdateCampaign,
  "AWS.IoTFleetWise.UpdateCampaign",
  (
    campaign: Campaign,
  ) => Effect.Effect<
    (
      request: UpdateCampaignRequest,
    ) => Effect.Effect<
      iotfleetwise.UpdateCampaignResponse,
      iotfleetwise.UpdateCampaignError
    >
  >
> {}
export const UpdateCampaign = Binding.Service<UpdateCampaign>(
  "AWS.IoTFleetWise.UpdateCampaign",
);
