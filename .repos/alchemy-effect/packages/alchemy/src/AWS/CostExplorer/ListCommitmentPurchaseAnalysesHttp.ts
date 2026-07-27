import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { ListCommitmentPurchaseAnalyses } from "./ListCommitmentPurchaseAnalyses.ts";

export const ListCommitmentPurchaseAnalysesHttp = Layer.effect(
  ListCommitmentPurchaseAnalyses,
  makeCostExplorerHttpBinding({
    capability: "ListCommitmentPurchaseAnalyses",
    iamActions: ["ce:ListCommitmentPurchaseAnalyses"],
    operation: ce.listCommitmentPurchaseAnalyses,
  }),
);
