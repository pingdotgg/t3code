import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetDimensionValues } from "./GetDimensionValues.ts";

export const GetDimensionValuesHttp = Layer.effect(
  GetDimensionValues,
  makeCostExplorerHttpBinding({
    capability: "GetDimensionValues",
    iamActions: ["ce:GetDimensionValues"],
    operation: ce.getDimensionValues,
  }),
);
