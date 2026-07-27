import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { GetFindingRecommendation } from "./GetFindingRecommendation.ts";

export const GetFindingRecommendationHttp = Layer.effect(
  GetFindingRecommendation,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.GetFindingRecommendation",
    operation: aa.getFindingRecommendation,
    actions: ["access-analyzer:GetFindingRecommendation"],
  }),
);
