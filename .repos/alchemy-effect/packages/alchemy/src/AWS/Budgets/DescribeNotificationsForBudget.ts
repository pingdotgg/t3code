import type * as budgets from "@distilled.cloud/aws/budgets";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Budget } from "./Budget.ts";

/**
 * Request for {@link DescribeNotificationsForBudget} — the bound budget's
 * `AccountId` and `BudgetName` are injected automatically.
 */
export interface DescribeNotificationsForBudgetRequest extends Omit<
  budgets.DescribeNotificationsForBudgetRequest,
  "AccountId" | "BudgetName"
> {}

/**
 * Runtime binding for `budgets:ViewBudget` via
 * `DescribeNotificationsForBudget`.
 *
 * Bind this operation to a {@link Budget} to list its alert thresholds and
 * their alarm state (`NotificationState` is `ALARM` once a threshold has been
 * crossed) — e.g. to gate expensive work on whether any budget alert has
 * fired. Provide the implementation with
 * `Effect.provide(AWS.Budgets.DescribeNotificationsForBudgetHttp)`.
 * @binding
 * @section Reading Budget Alerts
 * @example Check Whether Any Alert Is in Alarm
 * ```typescript
 * // init — bind the operation to the budget
 * const notifications = yield* AWS.Budgets.DescribeNotificationsForBudget(budget);
 *
 * // runtime
 * const result = yield* notifications();
 * const inAlarm = (result.Notifications ?? []).some(
 *   (n) => n.NotificationState === "ALARM",
 * );
 * ```
 */
export interface DescribeNotificationsForBudget extends Binding.Service<
  DescribeNotificationsForBudget,
  "AWS.Budgets.DescribeNotificationsForBudget",
  (
    budget: Budget,
  ) => Effect.Effect<
    (
      request?: DescribeNotificationsForBudgetRequest,
    ) => Effect.Effect<
      budgets.DescribeNotificationsForBudgetResponse,
      budgets.DescribeNotificationsForBudgetError
    >
  >
> {}

export const DescribeNotificationsForBudget =
  Binding.Service<DescribeNotificationsForBudget>(
    "AWS.Budgets.DescribeNotificationsForBudget",
  );
