import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCommitmentPurchaseAnalysis } from "./GetCommitmentPurchaseAnalysis.ts";

export const GetCommitmentPurchaseAnalysisHttp = Layer.effect(
  GetCommitmentPurchaseAnalysis,
  makeCostExplorerHttpBinding({
    capability: "GetCommitmentPurchaseAnalysis",
    iamActions: ["ce:GetCommitmentPurchaseAnalysis"],
    operation: ce.getCommitmentPurchaseAnalysis,
  }),
);
