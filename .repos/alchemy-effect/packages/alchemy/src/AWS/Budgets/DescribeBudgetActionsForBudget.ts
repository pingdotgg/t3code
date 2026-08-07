import type * as budgets from "@distilled.cloud/aws/budgets";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Budget } from "./Budget.ts";

/**
 * Request for {@link DescribeBudgetActionsForBudget} — the bound budget's
 * `AccountId` and `BudgetName` are injected automatically.
 */
export interface DescribeBudgetActionsForBudgetRequest extends Omit<
  budgets.DescribeBudgetActionsForBudgetRequest,
  "AccountId" | "BudgetName"
> {}

/**
 * Runtime binding for `budgets:DescribeBudgetActionsForBudget`.
 *
 * Bind this operation to a {@link Budget} to list its budget actions and
 * their execution status — e.g. to check whether a cost kill-switch has
 * fired. Provide the implementation with
 * `Effect.provide(AWS.Budgets.DescribeBudgetActionsForBudgetHttp)`.
 * @binding
 * @section Reading Budget Actions
 * @example List a Budget's Actions and Statuses
 * ```typescript
 * // init — bind the operation to the budget
 * const listActions = yield* AWS.Budgets.DescribeBudgetActionsForBudget(budget);
 *
 * // runtime
 * const result = yield* listActions();
 * const statuses = (result.Actions ?? []).map((a) => a.Status);
 * ```
 */
export interface DescribeBudgetActionsForBudget extends Binding.Service<
  DescribeBudgetActionsForBudget,
  "AWS.Budgets.DescribeBudgetActionsForBudget",
  (
    budget: Budget,
  ) => Effect.Effect<
    (
      request?: DescribeBudgetActionsForBudgetRequest,
    ) => Effect.Effect<
      budgets.DescribeBudgetActionsForBudgetResponse,
      budgets.DescribeBudgetActionsForBudgetError
    >
  >
> {}

export const DescribeBudgetActionsForBudget =
  Binding.Service<DescribeBudgetActionsForBudget>(
    "AWS.Budgets.DescribeBudgetActionsForBudget",
  );
