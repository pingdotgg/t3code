import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:GetLendingAnalysisSummary` — read the
 * document-group summary of an asynchronous lending-analysis job started
 * with `StartLendingAnalysis`.
 *
 * @binding
 * @section Asynchronous Lending Analysis
 * @example Summarize a Lending Analysis Job
 * ```typescript
 * // init
 * const getLendingAnalysisSummary =
 *   yield* AWS.Textract.GetLendingAnalysisSummary();
 *
 * // runtime
 * const result = yield* getLendingAnalysisSummary({ JobId: jobId });
 * const groups = result.Summary?.DocumentGroups;
 * ```
 */
export interface GetLendingAnalysisSummary extends Binding.Service<
  GetLendingAnalysisSummary,
  "AWS.Textract.GetLendingAnalysisSummary",
  () => Effect.Effect<
    (
      request: textract.GetLendingAnalysisSummaryRequest,
    ) => Effect.Effect<
      textract.GetLendingAnalysisSummaryResponse,
      textract.GetLendingAnalysisSummaryError
    >
  >
> {}
export const GetLendingAnalysisSummary =
  Binding.Service<GetLendingAnalysisSummary>(
    "AWS.Textract.GetLendingAnalysisSummary",
  );
