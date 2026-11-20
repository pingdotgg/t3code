import * as personalizeruntime from "@distilled.cloud/aws/personalize-runtime";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { GetActionRecommendations } from "./GetActionRecommendations.ts";

export const GetActionRecommendationsHttp = Layer.effect(
  GetActionRecommendations,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.GetActionRecommendations",
    operation: personalizeruntime.getActionRecommendations,
    actions: ["personalize:GetActionRecommendations"],
  }),
);
