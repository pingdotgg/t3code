import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { StartCostAllocationTagBackfill } from "./StartCostAllocationTagBackfill.ts";

export const StartCostAllocationTagBackfillHttp = Layer.effect(
  StartCostAllocationTagBackfill,
  makeCostExplorerHttpBinding({
    capability: "StartCostAllocationTagBackfill",
    iamActions: ["ce:StartCostAllocationTagBackfill"],
    operation: ce.startCostAllocationTagBackfill,
  }),
);
