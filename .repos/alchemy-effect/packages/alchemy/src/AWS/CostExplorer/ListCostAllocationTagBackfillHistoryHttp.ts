import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { ListCostAllocationTagBackfillHistory } from "./ListCostAllocationTagBackfillHistory.ts";

export const ListCostAllocationTagBackfillHistoryHttp = Layer.effect(
  ListCostAllocationTagBackfillHistory,
  makeCostExplorerHttpBinding({
    capability: "ListCostAllocationTagBackfillHistory",
    iamActions: ["ce:ListCostAllocationTagBackfillHistory"],
    operation: ce.listCostAllocationTagBackfillHistory,
  }),
);
