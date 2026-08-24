import * as budgets from "@distilled.cloud/aws/budgets";
import * as Layer from "effect/Layer";
import { makeBudgetHttpBinding } from "./BindingHttp.ts";
import { DescribeSubscribersForNotification } from "./DescribeSubscribersForNotification.ts";

export const DescribeSubscribersForNotificationHttp = Layer.effect(
  DescribeSubscribersForNotification,
  makeBudgetHttpBinding({
    tag: "AWS.Budgets.DescribeSubscribersForNotification",
    actions: ["budgets:ViewBudget"],
    operation: budgets.describeSubscribersForNotification,
  }),
);
