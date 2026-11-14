import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetSavingsPlansPurchaseRecommendation } from "./GetSavingsPlansPurchaseRecommendation.ts";

export const GetSavingsPlansPurchaseRecommendationHttp = Layer.effect(
  GetSavingsPlansPurchaseRecommendation,
  makeCostExplorerHttpBinding({
    capability: "GetSavingsPlansPurchaseRecommendation",
    iamActions: ["ce:GetSavingsPlansPurchaseRecommendation"],
    operation: ce.getSavingsPlansPurchaseRecommendation,
  }),
);
