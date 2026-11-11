import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import type { Campaign } from "./Campaign.ts";
import { UpdateCampaign } from "./UpdateCampaign.ts";

export const UpdateCampaignHttp = Layer.effect(
  UpdateCampaign,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.UpdateCampaign",
    operation: iotfleetwise.updateCampaign,
    actions: ["iotfleetwise:UpdateCampaign"],
    requestKey: "name",
    identifier: (campaign: Campaign) => campaign.campaignName,
    resources: (campaign: Campaign) => [campaign.campaignArn],
  }),
);
