import type * as budgets from "@distilled.cloud/aws/budgets";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Budget } from "./Budget.ts";

/**
 * Request for {@link DescribeBudget} — the bound budget's `AccountId` and
 * `BudgetName` are injected automatically.
 */
export interface DescribeBudgetRequest extends Omit<
  budgets.DescribeBudgetRequest,
  "AccountId" | "BudgetName"
> {}

/**
 * Runtime binding for `budgets:ViewBudget` via `DescribeBudget`.
 *
 * Bind this operation to a {@link Budget} to read its definition and — most
 * usefully at runtime — its `CalculatedSpend` (actual and forecasted spend so
 * far in the period), e.g. for a cost kill-switch or a spend dashboard.
 * Provide the implementation with
 * `Effect.provide(AWS.Budgets.DescribeBudgetHttp)`.
 * @binding
 * @section Reading Budget Spend
 * @example Check Actual Spend Against the Limit
 * ```typescript
 * // init — bind the operation to the budget
 * const describeBudget = yield* AWS.Budgets.DescribeBudget(budget);
 *
 * // runtime
 * const { Budget: b } = yield* describeBudget();
 * const actual = Number(b?.CalculatedSpend?.ActualSpend?.Amount ?? "0");
 * const limit = Number(b?.BudgetLimit?.Amount ?? "0");
 * const overBudget = limit > 0 && actual >= limit;
 * ```
 */
export interface DescribeBudget extends Binding.Service<
  DescribeBudget,
  "AWS.Budgets.DescribeBudget",
  (
    budget: Budget,
  ) => Effect.Effect<
    (
      request?: DescribeBudgetRequest,
    ) => Effect.Effect<
      budgets.DescribeBudgetResponse,
      budgets.DescribeBudgetError
    >
  >
> {}

export const DescribeBudget = Binding.Service<DescribeBudget>(
  "AWS.Budgets.DescribeBudget",
);
