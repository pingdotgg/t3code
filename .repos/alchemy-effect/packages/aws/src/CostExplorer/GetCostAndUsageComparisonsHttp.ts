import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCostAndUsageComparisons } from "./GetCostAndUsageComparisons.ts";

export const GetCostAndUsageComparisonsHttp = Layer.effect(
  GetCostAndUsageComparisons,
  makeCostExplorerHttpBinding({
    capability: "GetCostAndUsageComparisons",
    iamActions: ["ce:GetCostAndUsageComparisons"],
    operation: ce.getCostAndUsageComparisons,
  }),
);
