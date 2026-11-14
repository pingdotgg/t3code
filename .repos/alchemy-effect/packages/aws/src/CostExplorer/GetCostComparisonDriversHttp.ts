import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCostComparisonDrivers } from "./GetCostComparisonDrivers.ts";

export const GetCostComparisonDriversHttp = Layer.effect(
  GetCostComparisonDrivers,
  makeCostExplorerHttpBinding({
    capability: "GetCostComparisonDrivers",
    iamActions: ["ce:GetCostComparisonDrivers"],
    operation: ce.getCostComparisonDrivers,
  }),
);
