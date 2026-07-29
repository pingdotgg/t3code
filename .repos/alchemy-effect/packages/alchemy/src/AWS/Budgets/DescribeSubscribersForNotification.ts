import type * as budgets from "@distilled.cloud/aws/budgets";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Budget } from "./Budget.ts";

/**
 * Request for {@link DescribeSubscribersForNotification} — the bound budget's
 * `AccountId` and `BudgetName` are injected automatically. `Notification`
 * identifies which alert threshold to list subscribers for (the same shape
 * returned by `DescribeNotificationsForBudget`).
 */
export interface DescribeSubscribersForNotificationRequest extends Omit<
  budgets.DescribeSubscribersForNotificationRequest,
  "AccountId" | "BudgetName"
> {}

/**
 * Runtime binding for `budgets:ViewBudget` via
 * `DescribeSubscribersForNotification`.
 *
 * Bind this operation to a {@link Budget} to list who is notified when a
 * given alert threshold is crossed — pair it with
 * `DescribeNotificationsForBudget` to enumerate a budget's full alerting
 * fan-out (each subscriber's `Address` comes back `Redacted`). Provide the
 * implementation with
 * `Effect.provide(AWS.Budgets.DescribeSubscribersForNotificationHttp)`.
 * @binding
 * @section Reading Budget Alerts
 * @example List the Recipients of Each Alert
 * ```typescript
 * // init — bind both operations to the budget
 * const notifications = yield* AWS.Budgets.DescribeNotificationsForBudget(budget);
 * const subscribers = yield* AWS.Budgets.DescribeSubscribersForNotification(budget);
 *
 * // runtime
 * const { Notifications = [] } = yield* notifications();
 * for (const notification of Notifications) {
 *   const result = yield* subscribers({ Notification: notification });
 *   const recipients = (result.Subscribers ?? []).map((s) => s.SubscriptionType);
 * }
 * ```
 */
export interface DescribeSubscribersForNotification extends Binding.Service<
  DescribeSubscribersForNotification,
  "AWS.Budgets.DescribeSubscribersForNotification",
  (
    budget: Budget,
  ) => Effect.Effect<
    (
      request: DescribeSubscribersForNotificationRequest,
    ) => Effect.Effect<
      budgets.DescribeSubscribersForNotificationResponse,
      budgets.DescribeSubscribersForNotificationError
    >
  >
> {}

export const DescribeSubscribersForNotification =
  Binding.Service<DescribeSubscribersForNotification>(
    "AWS.Budgets.DescribeSubscribersForNotification",
  );
