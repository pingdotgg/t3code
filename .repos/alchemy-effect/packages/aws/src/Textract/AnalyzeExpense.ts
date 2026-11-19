import type * as textract from "@distilled.cloud/aws/textract";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `textract:AnalyzeExpense` — synchronous analysis of
 * invoices and receipts, extracting summary fields (vendor, total, dates)
 * and line-item groups.
 *
 * ### Synchronous Analysis
 * **Example:** Analyze an Invoice
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
 *
 * @binding
 */
export interface AnalyzeExpense extends Binding.Service<
  AnalyzeExpense,
  "AWS.Textract.AnalyzeExpense",
  () => Effect.Effect<
    (
      request: textract.AnalyzeExpenseRequest,
    ) => Effect.Effect<textract.AnalyzeExpenseResponse, textract.AnalyzeExpenseError>
  >
> {}
export const AnalyzeExpense = Binding.Service<AnalyzeExpense>("AWS.Textract.AnalyzeExpense");
