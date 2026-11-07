import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCostAndUsageWithResources } from "./GetCostAndUsageWithResources.ts";

export const GetCostAndUsageWithResourcesHttp = Layer.effect(
  GetCostAndUsageWithResources,
  makeCostExplorerHttpBinding({
    capability: "GetCostAndUsageWithResources",
    iamActions: ["ce:GetCostAndUsageWithResources"],
    operation: ce.getCostAndUsageWithResources,
  }),
);
