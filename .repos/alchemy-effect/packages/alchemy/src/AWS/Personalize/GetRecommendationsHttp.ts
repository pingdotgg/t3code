import * as personalizeruntime from "@distilled.cloud/aws/personalize-runtime";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { GetRecommendations } from "./GetRecommendations.ts";

export const GetRecommendationsHttp = Layer.effect(
  GetRecommendations,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.GetRecommendations",
    operation: personalizeruntime.getRecommendations,
    actions: ["personalize:GetRecommendations"],
  }),
);
