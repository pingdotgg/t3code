import * as budgets from "@distilled.cloud/aws/budgets";
import * as Layer from "effect/Layer";
import { makeBudgetHttpBinding } from "./BindingHttp.ts";
import { DescribeBudgetActionsForBudget } from "./DescribeBudgetActionsForBudget.ts";

export const DescribeBudgetActionsForBudgetHttp = Layer.effect(
  DescribeBudgetActionsForBudget,
  makeBudgetHttpBinding({
    tag: "AWS.Budgets.DescribeBudgetActionsForBudget",
    actions: ["budgets:DescribeBudgetActionsForBudget"],
    operation: budgets.describeBudgetActionsForBudget,
    // Authorizes on the budgetAction resource type; action IDs are
    // unknowable at deploy time.
    actionWildcard: true,
  }),
);
