import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";
import { GetLendingAnalysisSummary } from "./GetLendingAnalysisSummary.ts";

export const GetLendingAnalysisSummaryHttp = Layer.effect(
  GetLendingAnalysisSummary,
  makeTextractHttpBinding({
    capability: "GetLendingAnalysisSummary",
    // No resource-level IAM for this action.
    iamActions: ["textract:GetLendingAnalysisSummary"],
    operation: textract.getLendingAnalysisSummary,
  }),
);
