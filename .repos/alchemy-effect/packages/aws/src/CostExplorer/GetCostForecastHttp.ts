import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCostForecast } from "./GetCostForecast.ts";

export const GetCostForecastHttp = Layer.effect(
  GetCostForecast,
  makeCostExplorerHttpBinding({
    capability: "GetCostForecast",
    iamActions: ["ce:GetCostForecast"],
    operation: ce.getCostForecast,
  }),
);
