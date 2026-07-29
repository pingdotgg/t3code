import * as budgets from "@distilled.cloud/aws/budgets";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * A subscriber notified when a budget notification is triggered.
 */
export interface BudgetSubscriber {
  /**
   * How the subscriber is notified.
   */
  subscriptionType: "EMAIL" | "SNS" | (string & {});
  /**
   * The destination — an email address (for `EMAIL`) or an SNS topic ARN
   * (for `SNS`).
   */
  address: string;
}

/**
 * A threshold that, when crossed, notifies the configured subscribers.
 */
export interface BudgetNotification {
  /**
   * Whether the notification is based on actual or forecasted spend/usage.
   */
  notificationType: "ACTUAL" | "FORECASTED" | (string & {});
  /**
   * How the actual/forecasted amount is compared to the threshold.
   */
  comparisonOperator: "GREATER_THAN" | "LESS_THAN" | "EQUAL_TO" | (string & {});
  /**
   * The threshold value. Interpreted as a percentage of the budget limit by
   * default, or an absolute amount when `thresholdType` is `ABSOLUTE_VALUE`.
   */
  threshold: number;
  /**
   * Whether `threshold` is a percentage of the budget or an absolute value.
   * @default "PERCENTAGE"
   */
  thresholdType?: "PERCENTAGE" | "ABSOLUTE_VALUE" | (string & {});
  /**
   * Subscribers notified when this threshold is crossed.
   */
  subscribers: BudgetSubscriber[];
}

export interface BudgetProps {
  /**
   * Name of the budget. Must be unique within the account. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   *
   * Changing the name replaces the budget.
   */
  budgetName?: string;
  /**
   * What the budget tracks.
   * @default "COST"
   */
  budgetType?:
    | "COST"
    | "USAGE"
    | "RI_UTILIZATION"
    | "RI_COVERAGE"
    | "SAVINGS_PLANS_UTILIZATION"
    | "SAVINGS_PLANS_COVERAGE"
    | (string & {});
  /**
   * The period the budget resets over.
   * @default "MONTHLY"
   */
  timeUnit?: "DAILY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY" | (string & {});
  /**
   * The budgeted amount and its unit, e.g. `{ amount: "100", unit: "USD" }`.
   * Required for `COST` and `USAGE` budgets.
   */
  budgetLimit?: {
    /** The amount, as a string, e.g. `"100"`. */
    amount: string;
    /** The unit — `"USD"` for cost budgets, or the usage unit. */
    unit: string;
  };
  /**
   * Cost filters restricting which costs count against the budget, e.g.
   * `{ Service: ["Amazon Elastic Compute Cloud - Compute"] }`.
   */
  costFilters?: Record<string, string[]>;
  /**
   * Notifications and their subscribers.
   */
  notifications?: BudgetNotification[];
  /**
   * Tags applied to the budget at creation.
   */
  tags?: Record<string, string>;
}

export interface Budget extends Resource<
  "AWS.Budgets.Budget",
  BudgetProps,
  {
    /**
     * Name of the budget.
     */
    budgetName: string;
    /**
     * The AWS account ID that owns the budget.
     */
    accountId: string;
    /**
     * ARN of the budget, e.g. `arn:aws:budgets::123456789012:budget/my-budget`.
     */
    budgetArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Budget — tracks cost or usage against a defined limit over a time
 * period and notifies subscribers when configured thresholds are crossed.
 *
 * Budgets are a global (account-level) resource; they are free and take
 * effect immediately.
 *
 * @resource
 * @section Creating a Budget
 * @example Monthly cost budget with an email alert at 80%
 * ```typescript
 * import * as Budgets from "alchemy/AWS/Budgets";
 *
 * const budget = yield* Budgets.Budget("MonthlyCost", {
 *   budgetType: "COST",
 *   timeUnit: "MONTHLY",
 *   budgetLimit: { amount: "100", unit: "USD" },
 *   notifications: [
 *     {
 *       notificationType: "ACTUAL",
 *       comparisonOperator: "GREATER_THAN",
 *       threshold: 80,
 *       thresholdType: "PERCENTAGE",
 *       subscribers: [{ subscriptionType: "EMAIL", address: "team@example.com" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @example Budget scoped to a single service
 * ```typescript
 * const budget = yield* Budgets.Budget("EC2Spend", {
 *   budgetLimit: { amount: "500", unit: "USD" },
 *   costFilters: {
 *     Service: ["Amazon Elastic Compute Cloud - Compute"],
 *   },
 * });
 * ```
 */
export const Budget = Resource<Budget>("AWS.Budgets.Budget");

/**
 * Compute the ARN of a budget. Budgets is a global service, so the ARN has no
 * region component.
 */
export const budgetArn = (accountId: string, budgetName: string): string =>
  `arn:aws:budgets::${accountId}:budget/${budgetName}`;

const notificationKey = (n: budgets.Notification): string =>
  JSON.stringify({
    NotificationType: n.NotificationType,
    ComparisonOperator: n.ComparisonOperator,
    Threshold: n.Threshold,
    ThresholdType: n.ThresholdType ?? "PERCENTAGE",
  });

const toNotification = (n: BudgetNotification): budgets.Notification => ({
  NotificationType: n.notificationType,
  ComparisonOperator: n.comparisonOperator,
  Threshold: n.threshold,
  ThresholdType: n.thresholdType ?? "PERCENTAGE",
});

/**
 * Distilled marks `Subscriber.Address` sensitive, so observed subscribers
 * come back as `Redacted` — unwrap before diffing, or every observed
 * subscriber compares as `<redacted>` and gets torn down (and deleting the
 * last subscriber deletes the whole notification).
 */
const subscriberAddress = (s: budgets.Subscriber): string =>
  Redacted.isRedacted(s.Address) ? Redacted.value(s.Address) : s.Address;

const subscriberKey = (s: budgets.Subscriber): string =>
  `${s.SubscriptionType}:${subscriberAddress(s)}`;

export const BudgetProvider = () =>
  Provider.effect(
    Budget,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { budgetName?: string | undefined },
      ) {
        return (
          props.budgetName ??
          (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      const buildBudget = (
        name: string,
        props: BudgetProps,
      ): budgets.Budget => ({
        BudgetName: name,
        BudgetType: props.budgetType ?? "COST",
        TimeUnit: props.timeUnit ?? "MONTHLY",
        BudgetLimit: props.budgetLimit
          ? { Amount: props.budgetLimit.amount, Unit: props.budgetLimit.unit }
          : undefined,
        CostFilters: props.costFilters,
      });

      const syncNotifications = Effect.fn(function* (
        accountId: string,
        name: string,
        desired: BudgetNotification[],
      ) {
        const current = yield* budgets.describeNotificationsForBudget
          .pages({
            AccountId: accountId,
            BudgetName: name,
          })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Notifications ?? []),
            ),
            Effect.catchTag("NotFoundException", () => Effect.succeed([])),
          );
        const currentKeys = new Set(current.map(notificationKey));
        const desiredNotifs = desired.map(toNotification);
        const desiredKeys = new Set(desiredNotifs.map(notificationKey));

        for (const n of desired) {
          const notif = toNotification(n);
          const desiredSubscribers = n.subscribers.map(
            (s): budgets.Subscriber => ({
              SubscriptionType: s.subscriptionType,
              Address: s.address,
            }),
          );
          if (!currentKeys.has(notificationKey(notif))) {
            // The notification listing is eventually consistent — right after
            // `createBudget(NotificationsWithSubscribers)` it can come back
            // empty, so an already-created notification surfaces here as a
            // DuplicateRecordException race.
            yield* budgets
              .createNotification({
                AccountId: accountId,
                BudgetName: name,
                Notification: notif,
                Subscribers: desiredSubscribers,
              })
              .pipe(
                Effect.catchTag("DuplicateRecordException", () => Effect.void),
              );
            continue;
          }
          // The notification already exists — converge its subscribers by
          // diffing the OBSERVED subscriber list against the desired one.
          const observedSubscribers = yield* budgets
            .describeSubscribersForNotification({
              AccountId: accountId,
              BudgetName: name,
              Notification: notif,
            })
            .pipe(
              Effect.map((r) => r.Subscribers ?? []),
              Effect.catchTag("NotFoundException", () => Effect.succeed([])),
            );
          const observedKeys = new Set(observedSubscribers.map(subscriberKey));
          const desiredSubKeys = new Set(desiredSubscribers.map(subscriberKey));
          // Create before delete so the notification never drops to zero
          // subscribers (the API requires at least one).
          for (const s of desiredSubscribers) {
            if (observedKeys.has(subscriberKey(s))) continue;
            yield* budgets
              .createSubscriber({
                AccountId: accountId,
                BudgetName: name,
                Notification: notif,
                Subscriber: s,
              })
              .pipe(
                Effect.catchTag("DuplicateRecordException", () => Effect.void),
              );
          }
          for (const s of observedSubscribers) {
            if (desiredSubKeys.has(subscriberKey(s))) continue;
            yield* budgets
              .deleteSubscriber({
                AccountId: accountId,
                BudgetName: name,
                Notification: notif,
                Subscriber: s,
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          }
        }
        for (const n of current) {
          if (desiredKeys.has(notificationKey(n))) continue;
          yield* budgets
            .deleteNotification({
              AccountId: accountId,
              BudgetName: name,
              Notification: n,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }
      });

      const syncTags = Effect.fn(function* (
        arn: string,
        desired: Record<string, string>,
      ) {
        // Diff against OBSERVED cloud tags (not olds/output) so adoption and
        // out-of-band drift converge correctly.
        const observed = yield* budgets
          .listTagsForResource({ ResourceARN: arn })
          .pipe(
            Effect.map((r) =>
              Object.fromEntries(
                (r.ResourceTags ?? []).map((t) => [t.Key, t.Value]),
              ),
            ),
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );
        const { removed, upsert } = diffTags(observed, desired);
        if (upsert.length > 0) {
          yield* budgets.tagResource({
            ResourceARN: arn,
            ResourceTags: upsert,
          });
        }
        if (removed.length > 0) {
          yield* budgets.untagResource({
            ResourceARN: arn,
            ResourceTagKeys: removed,
          });
        }
      });

      return Budget.Provider.of({
        stables: ["budgetName", "accountId", "budgetArn"],
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            return yield* budgets.describeBudgets
              .pages({ AccountId: accountId })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk)
                    .flatMap((page) => page.Budgets ?? [])
                    .map((b) => ({
                      budgetName: b.BudgetName,
                      accountId,
                      budgetArn: budgetArn(accountId, b.BudgetName),
                    })),
                ),
                Effect.catchTag("NotFoundException", () => Effect.succeed([])),
              );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name =
            output?.budgetName ?? (yield* createName(id, olds ?? {}));
          const found = yield* budgets
            .describeBudget({ AccountId: accountId, BudgetName: name })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!found?.Budget) return undefined;
          return {
            budgetName: name,
            accountId,
            budgetArn: budgetArn(accountId, name),
          };
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = output?.budgetName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const budgetBody = buildBudget(name, news);

          // OBSERVE — cloud state is authoritative.
          const live = yield* budgets
            .describeBudget({ AccountId: accountId, BudgetName: name })
            .pipe(
              Effect.map((r) => r.Budget),
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!live) {
            // ENSURE — create; tolerate a DuplicateRecord race.
            yield* budgets
              .createBudget({
                AccountId: accountId,
                Budget: budgetBody,
                NotificationsWithSubscribers: news.notifications?.map((n) => ({
                  Notification: toNotification(n),
                  Subscribers: n.subscribers.map((s) => ({
                    SubscriptionType: s.subscriptionType,
                    Address: s.address,
                  })),
                })),
                ResourceTags: Object.entries({
                  ...news.tags,
                  ...internalTags,
                }).map(([Key, Value]) => ({ Key, Value })),
              })
              .pipe(
                Effect.catchTag("DuplicateRecordException", () =>
                  budgets.updateBudget({
                    AccountId: accountId,
                    NewBudget: budgetBody,
                  }),
                ),
              );
          } else {
            // SYNC — updateBudget is a full replace of the budget definition.
            yield* budgets.updateBudget({
              AccountId: accountId,
              NewBudget: budgetBody,
            });
          }

          // SYNC notifications — the budget update does not touch these.
          yield* syncNotifications(accountId, name, news.notifications ?? []);

          // SYNC tags against observed cloud tags.
          const arn = budgetArn(accountId, name);
          yield* syncTags(arn, { ...news.tags, ...internalTags });

          yield* session.note(name);
          return { budgetName: name, accountId, budgetArn: arn };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* budgets
            .deleteBudget({
              AccountId: output.accountId,
              BudgetName: output.budgetName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
