import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { GenerateFindingRecommendation } from "./GenerateFindingRecommendation.ts";

export const GenerateFindingRecommendationHttp = Layer.effect(
  GenerateFindingRecommendation,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.GenerateFindingRecommendation",
    operation: aa.generateFindingRecommendation,
    actions: ["access-analyzer:GenerateFindingRecommendation"],
  }),
);
