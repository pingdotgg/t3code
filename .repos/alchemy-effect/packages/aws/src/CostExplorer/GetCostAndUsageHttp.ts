import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCostAndUsage } from "./GetCostAndUsage.ts";

export const GetCostAndUsageHttp = Layer.effect(
  GetCostAndUsage,
  makeCostExplorerHttpBinding({
    capability: "GetCostAndUsage",
    iamActions: ["ce:GetCostAndUsage"],
    operation: ce.getCostAndUsage,
  }),
);
