import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetSavingsPlansUtilizationDetails } from "./GetSavingsPlansUtilizationDetails.ts";

export const GetSavingsPlansUtilizationDetailsHttp = Layer.effect(
  GetSavingsPlansUtilizationDetails,
  makeCostExplorerHttpBinding({
    capability: "GetSavingsPlansUtilizationDetails",
    iamActions: ["ce:GetSavingsPlansUtilizationDetails"],
    operation: ce.getSavingsPlansUtilizationDetails,
  }),
);
