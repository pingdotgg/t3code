import * as personalize from "@distilled.cloud/aws/personalize";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateCampaign } from "./UpdateCampaign.ts";

export const UpdateCampaignHttp = Layer.effect(
  UpdateCampaign,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.UpdateCampaign",
    operation: personalize.updateCampaign,
    actions: ["personalize:UpdateCampaign"],
  }),
);
