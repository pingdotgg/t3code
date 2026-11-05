import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetSavingsPlansCoverage } from "./GetSavingsPlansCoverage.ts";

export const GetSavingsPlansCoverageHttp = Layer.effect(
  GetSavingsPlansCoverage,
  makeCostExplorerHttpBinding({
    capability: "GetSavingsPlansCoverage",
    iamActions: ["ce:GetSavingsPlansCoverage"],
    operation: ce.getSavingsPlansCoverage,
  }),
);
