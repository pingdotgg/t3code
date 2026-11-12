import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetReservationPurchaseRecommendation } from "./GetReservationPurchaseRecommendation.ts";

export const GetReservationPurchaseRecommendationHttp = Layer.effect(
  GetReservationPurchaseRecommendation,
  makeCostExplorerHttpBinding({
    capability: "GetReservationPurchaseRecommendation",
    iamActions: ["ce:GetReservationPurchaseRecommendation"],
    operation: ce.getReservationPurchaseRecommendation,
  }),
);
