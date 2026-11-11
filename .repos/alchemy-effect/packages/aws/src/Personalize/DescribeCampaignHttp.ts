import * as personalize from "@distilled.cloud/aws/personalize";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeCampaign } from "./DescribeCampaign.ts";

export const DescribeCampaignHttp = Layer.effect(
  DescribeCampaign,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.DescribeCampaign",
    operation: personalize.describeCampaign,
    actions: ["personalize:DescribeCampaign"],
  }),
);
