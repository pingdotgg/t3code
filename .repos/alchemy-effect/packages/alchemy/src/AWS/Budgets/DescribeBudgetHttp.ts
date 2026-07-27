import * as budgets from "@distilled.cloud/aws/budgets";
import * as Layer from "effect/Layer";
import { makeBudgetHttpBinding } from "./BindingHttp.ts";
import { DescribeBudget } from "./DescribeBudget.ts";

export const DescribeBudgetHttp = Layer.effect(
  DescribeBudget,
  makeBudgetHttpBinding({
    tag: "AWS.Budgets.DescribeBudget",
    actions: ["budgets:ViewBudget"],
    operation: budgets.describeBudget,
  }),
);
