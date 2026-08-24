import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:AnalyzeExpense` — synchronous analysis of
 * invoices and receipts, extracting summary fields (vendor, total, dates)
 * and line-item groups.
 *
 * @binding
 * @section Synchronous Analysis
 * @example Analyze an Invoice
 * ```typescript
 * // init
 * const analyzeExpense = yield* AWS.Textract.AnalyzeExpense();
 *
 * // runtime
 * const result = yield* analyzeExpense({
 *   Document: { Bytes: receiptBytes },
 * });
 * const fields = result.ExpenseDocuments?.[0]?.SummaryFields;
 * ```
 */
export interface AnalyzeExpense extends Binding.Service<
  AnalyzeExpense,
  "AWS.Textract.AnalyzeExpense",
  () => Effect.Effect<
    (
      request: textract.AnalyzeExpenseRequest,
    ) => Effect.Effect<
      textract.AnalyzeExpenseResponse,
      textract.AnalyzeExpenseError
    >
  >
> {}
export const AnalyzeExpense = Binding.Service<AnalyzeExpense>(
  "AWS.Textract.AnalyzeExpense",
);
