import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { StartSavingsPlansPurchaseRecommendationGeneration } from "./StartSavingsPlansPurchaseRecommendationGeneration.ts";

export const StartSavingsPlansPurchaseRecommendationGenerationHttp =
  Layer.effect(
    StartSavingsPlansPurchaseRecommendationGeneration,
    makeCostExplorerHttpBinding({
      capability: "StartSavingsPlansPurchaseRecommendationGeneration",
      iamActions: ["ce:StartSavingsPlansPurchaseRecommendationGeneration"],
      operation: ce.startSavingsPlansPurchaseRecommendationGeneration,
    }),
  );
