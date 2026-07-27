import type * as budgets from "@distilled.cloud/aws/budgets";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BudgetAction } from "./BudgetAction.ts";

/**
 * Request for {@link DescribeBudgetActionHistories} — the bound action's
 * `AccountId`, `BudgetName`, and `ActionId` are injected automatically.
 */
export interface DescribeBudgetActionHistoriesRequest extends Omit<
  budgets.DescribeBudgetActionHistoriesRequest,
  "AccountId" | "BudgetName" | "ActionId"
> {}

/**
 * Runtime binding for `budgets:DescribeBudgetActionHistories`.
 *
 * Bind this operation to a {@link BudgetAction} to read its event history —
 * creations, updates, and executions with their statuses — e.g. to audit
 * when a kill-switch fired and whether it succeeded. Provide the
 * implementation with
 * `Effect.provide(AWS.Budgets.DescribeBudgetActionHistoriesHttp)`.
 * @binding
 * @section Reading Budget Actions
 * @example Read an Action's Event History
 * ```typescript
 * // init — bind the operation to the action
 * const histories = yield* AWS.Budgets.DescribeBudgetActionHistories(action);
 *
 * // runtime
 * const result = yield* histories({});
 * const executions = result.ActionHistories.filter(
 *   (h) => h.EventType === "EXECUTE_ACTION",
 * );
 * ```
 */
export interface DescribeBudgetActionHistories extends Binding.Service<
  DescribeBudgetActionHistories,
  "AWS.Budgets.DescribeBudgetActionHistories",
  (
    action: BudgetAction,
  ) => Effect.Effect<
    (
      request: DescribeBudgetActionHistoriesRequest,
    ) => Effect.Effect<
      budgets.DescribeBudgetActionHistoriesResponse,
      budgets.DescribeBudgetActionHistoriesError
    >
  >
> {}

export const DescribeBudgetActionHistories =
  Binding.Service<DescribeBudgetActionHistories>(
    "AWS.Budgets.DescribeBudgetActionHistories",
  );
