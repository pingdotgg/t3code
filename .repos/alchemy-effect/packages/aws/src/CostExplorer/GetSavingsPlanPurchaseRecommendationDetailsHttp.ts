import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetSavingsPlanPurchaseRecommendationDetails } from "./GetSavingsPlanPurchaseRecommendationDetails.ts";

export const GetSavingsPlanPurchaseRecommendationDetailsHttp = Layer.effect(
  GetSavingsPlanPurchaseRecommendationDetails,
  makeCostExplorerHttpBinding({
    capability: "GetSavingsPlanPurchaseRecommendationDetails",
    iamActions: ["ce:GetSavingsPlanPurchaseRecommendationDetails"],
    operation: ce.getSavingsPlanPurchaseRecommendationDetails,
  }),
);
