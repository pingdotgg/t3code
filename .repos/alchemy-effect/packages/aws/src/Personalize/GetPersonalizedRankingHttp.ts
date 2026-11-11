import * as personalizeruntime from "@distilled.cloud/aws/personalize-runtime";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { GetPersonalizedRanking } from "./GetPersonalizedRanking.ts";

export const GetPersonalizedRankingHttp = Layer.effect(
  GetPersonalizedRanking,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.GetPersonalizedRanking",
    operation: personalizeruntime.getPersonalizedRanking,
    actions: ["personalize:GetPersonalizedRanking"],
  }),
);
