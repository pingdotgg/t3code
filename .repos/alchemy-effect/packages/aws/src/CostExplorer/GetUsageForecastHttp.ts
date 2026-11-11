import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetUsageForecast } from "./GetUsageForecast.ts";

export const GetUsageForecastHttp = Layer.effect(
  GetUsageForecast,
  makeCostExplorerHttpBinding({
    capability: "GetUsageForecast",
    iamActions: ["ce:GetUsageForecast"],
    operation: ce.getUsageForecast,
  }),
);
