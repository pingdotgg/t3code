import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";
import { GetLendingAnalysis } from "./GetLendingAnalysis.ts";

export const GetLendingAnalysisHttp = Layer.effect(
  GetLendingAnalysis,
  makeTextractHttpBinding({
    capability: "GetLendingAnalysis",
    // No resource-level IAM for this action.
    iamActions: ["textract:GetLendingAnalysis"],
    operation: textract.getLendingAnalysis,
  }),
);
