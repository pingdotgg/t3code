import type * as budgets from "@distilled.cloud/aws/budgets";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BudgetAction } from "./BudgetAction.ts";

/**
 * Request for {@link ExecuteBudgetAction} — the bound action's `AccountId`,
 * `BudgetName`, and `ActionId` are injected automatically.
 */
export interface ExecuteBudgetActionRequest extends Omit<
  budgets.ExecuteBudgetActionRequest,
  "AccountId" | "BudgetName" | "ActionId"
> {}

/**
 * Runtime binding for `budgets:ExecuteBudgetAction`.
 *
 * Bind this operation to a {@link BudgetAction} to approve, retry, reverse,
 * or reset it from inside a function runtime — e.g. an approval workflow that
 * approves a pending kill-switch, or an automated recovery that reverses it
 * at the start of a new period. Provide the implementation with
 * `Effect.provide(AWS.Budgets.ExecuteBudgetActionHttp)`.
 * @binding
 * @section Executing Budget Actions
 * @example Approve a Pending Action
 * ```typescript
 * // init — bind the operation to the action
 * const execute = yield* AWS.Budgets.ExecuteBudgetAction(action);
 *
 * // runtime
 * yield* execute({ ExecutionType: "APPROVE_BUDGET_ACTION" });
 * ```
 *
 * @example Reverse an Executed Action
 * ```typescript
 * yield* execute({ ExecutionType: "REVERSE_BUDGET_ACTION" });
 * ```
 */
export interface ExecuteBudgetAction extends Binding.Service<
  ExecuteBudgetAction,
  "AWS.Budgets.ExecuteBudgetAction",
  (
    action: BudgetAction,
  ) => Effect.Effect<
    (
      request: ExecuteBudgetActionRequest,
    ) => Effect.Effect<
      budgets.ExecuteBudgetActionResponse,
      budgets.ExecuteBudgetActionError
    >
  >
> {}

export const ExecuteBudgetAction = Binding.Service<ExecuteBudgetAction>(
  "AWS.Budgets.ExecuteBudgetAction",
);
