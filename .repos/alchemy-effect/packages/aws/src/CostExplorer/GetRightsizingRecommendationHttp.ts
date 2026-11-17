import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetRightsizingRecommendation } from "./GetRightsizingRecommendation.ts";

export const GetRightsizingRecommendationHttp = Layer.effect(
  GetRightsizingRecommendation,
  makeCostExplorerHttpBinding({
    capability: "GetRightsizingRecommendation",
    iamActions: ["ce:GetRightsizingRecommendation"],
    operation: ce.getRightsizingRecommendation,
  }),
);
