import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { AnalyzeExpense } from "./AnalyzeExpense.ts";
import { makeTextractHttpBinding } from "./BindingHttp.ts";

export const AnalyzeExpenseHttp = Layer.effect(
  AnalyzeExpense,
  makeTextractHttpBinding({
    capability: "AnalyzeExpense",
    // No resource-level IAM for this action.
    iamActions: ["textract:AnalyzeExpense"],
    operation: textract.analyzeExpense,
  }),
);
