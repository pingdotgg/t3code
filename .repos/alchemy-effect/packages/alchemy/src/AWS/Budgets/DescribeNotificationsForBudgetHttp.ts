import * as budgets from "@distilled.cloud/aws/budgets";
import * as Layer from "effect/Layer";
import { makeBudgetHttpBinding } from "./BindingHttp.ts";
import { DescribeNotificationsForBudget } from "./DescribeNotificationsForBudget.ts";

export const DescribeNotificationsForBudgetHttp = Layer.effect(
  DescribeNotificationsForBudget,
  makeBudgetHttpBinding({
    tag: "AWS.Budgets.DescribeNotificationsForBudget",
    actions: ["budgets:ViewBudget"],
    operation: budgets.describeNotificationsForBudget,
  }),
);
