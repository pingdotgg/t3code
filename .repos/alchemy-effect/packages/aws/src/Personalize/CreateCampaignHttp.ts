import * as personalize from "@distilled.cloud/aws/personalize";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { CreateCampaign } from "./CreateCampaign.ts";

export const CreateCampaignHttp = Layer.effect(
  CreateCampaign,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.CreateCampaign",
    operation: personalize.createCampaign,
    actions: ["personalize:CreateCampaign"],
  }),
);
