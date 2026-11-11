import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";
import { StartExpenseAnalysis } from "./StartExpenseAnalysis.ts";

export const StartExpenseAnalysisHttp = Layer.effect(
  StartExpenseAnalysis,
  makeTextractHttpBinding({
    capability: "StartExpenseAnalysis",
    // No resource-level IAM for this action.
    iamActions: ["textract:StartExpenseAnalysis"],
    operation: textract.startExpenseAnalysis,
  }),
);
