import * as budgets from "@distilled.cloud/aws/budgets";
import * as Layer from "effect/Layer";
import { makeBudgetActionHttpBinding } from "./BindingHttp.ts";
import { ExecuteBudgetAction } from "./ExecuteBudgetAction.ts";

export const ExecuteBudgetActionHttp = Layer.effect(
  ExecuteBudgetAction,
  makeBudgetActionHttpBinding({
    tag: "AWS.Budgets.ExecuteBudgetAction",
    actions: ["budgets:ExecuteBudgetAction"],
    operation: budgets.executeBudgetAction,
  }),
);
