import type * as budgets from "@distilled.cloud/aws/budgets";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Budget } from "./Budget.ts";

/**
 * Request for {@link DescribeBudgetPerformanceHistory} — the bound budget's
 * `AccountId` and `BudgetName` are injected automatically.
 */
export interface DescribeBudgetPerformanceHistoryRequest extends Omit<
  budgets.DescribeBudgetPerformanceHistoryRequest,
  "AccountId" | "BudgetName"
> {}

/**
 * Runtime binding for `budgets:ViewBudget` via
 * `DescribeBudgetPerformanceHistory`.
 *
 * Bind this operation to a {@link Budget} to read its budgeted-vs-actual
 * amounts for past periods — e.g. to render a spend trend or detect
 * consistently blown budgets. Provide the implementation with
 * `Effect.provide(AWS.Budgets.DescribeBudgetPerformanceHistoryHttp)`.
 * @binding
 * @section Reading Budget Spend
 * @example Read Budgeted vs Actual Amounts
 * ```typescript
 * // init — bind the operation to the budget
 * const history = yield* AWS.Budgets.DescribeBudgetPerformanceHistory(budget);
 *
 * // runtime
 * const result = yield* history();
 * const periods =
 *   result.BudgetPerformanceHistory?.BudgetedAndActualAmountsList ?? [];
 * ```
 */
export interface DescribeBudgetPerformanceHistory extends Binding.Service<
  DescribeBudgetPerformanceHistory,
  "AWS.Budgets.DescribeBudgetPerformanceHistory",
  (
    budget: Budget,
  ) => Effect.Effect<
    (
      request?: DescribeBudgetPerformanceHistoryRequest,
    ) => Effect.Effect<
      budgets.DescribeBudgetPerformanceHistoryResponse,
      budgets.DescribeBudgetPerformanceHistoryError
    >
  >
> {}

export const DescribeBudgetPerformanceHistory =
  Binding.Service<DescribeBudgetPerformanceHistory>(
    "AWS.Budgets.DescribeBudgetPerformanceHistory",
  );
