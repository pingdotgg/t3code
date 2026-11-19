import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { UpdateCostAllocationTagsStatus } from "./UpdateCostAllocationTagsStatus.ts";

export const UpdateCostAllocationTagsStatusHttp = Layer.effect(
  UpdateCostAllocationTagsStatus,
  makeCostExplorerHttpBinding({
    capability: "UpdateCostAllocationTagsStatus",
    iamActions: ["ce:UpdateCostAllocationTagsStatus"],
    operation: ce.updateCostAllocationTagsStatus,
  }),
);
