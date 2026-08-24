import * as budgets from "@distilled.cloud/aws/budgets";
import * as Layer from "effect/Layer";
import { makeBudgetHttpBinding } from "./BindingHttp.ts";
import { DescribeBudgetPerformanceHistory } from "./DescribeBudgetPerformanceHistory.ts";

export const DescribeBudgetPerformanceHistoryHttp = Layer.effect(
  DescribeBudgetPerformanceHistory,
  makeBudgetHttpBinding({
    tag: "AWS.Budgets.DescribeBudgetPerformanceHistory",
    actions: ["budgets:ViewBudget"],
    operation: budgets.describeBudgetPerformanceHistory,
  }),
);
