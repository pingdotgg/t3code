import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";
import { StartLendingAnalysis } from "./StartLendingAnalysis.ts";

export const StartLendingAnalysisHttp = Layer.effect(
  StartLendingAnalysis,
  makeTextractHttpBinding({
    capability: "StartLendingAnalysis",
    // No resource-level IAM for this action.
    iamActions: ["textract:StartLendingAnalysis"],
    operation: textract.startLendingAnalysis,
  }),
);
