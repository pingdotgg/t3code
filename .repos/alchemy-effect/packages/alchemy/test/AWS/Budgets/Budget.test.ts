import * as AWS from "@/AWS";
import { Budget } from "@/AWS/Budgets/Budget.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as budgets from "@distilled.cloud/aws/budgets";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const budgetName = "alchemy-test-budget-lifecycle";

const getBudget = (accountId: string) =>
  budgets.describeBudget({ AccountId: accountId, BudgetName: budgetName }).pipe(
    Effect.map((r) => r.Budget),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

const getTags = (arn: string) =>
  budgets.listTagsForResource({ ResourceARN: arn }).pipe(
    Effect.map((r) =>
      Object.fromEntries((r.ResourceTags ?? []).map((t) => [t.Key, t.Value])),
    ),
    Effect.catchTag("NotFoundException", () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );

// The notification/subscriber listings are eventually consistent for a few
// seconds after a write — poll boundedly instead of asserting immediately.
const consistencyPolicy = {
  schedule: Schedule.spaced("2 seconds"),
  times: 15,
} as const;

const getNotifications = (accountId: string) =>
  budgets
    .describeNotificationsForBudget({
      AccountId: accountId,
      BudgetName: budgetName,
    })
    .pipe(
      Effect.map((r) => r.Notifications ?? []),
      Effect.catchTag("NotFoundException", () => Effect.succeed([])),
    );

const getSubscribers = (accountId: string, threshold: number) =>
  budgets
    .describeSubscribersForNotification({
      AccountId: accountId,
      BudgetName: budgetName,
      Notification: {
        NotificationType: "ACTUAL",
        ComparisonOperator: "GREATER_THAN",
        Threshold: threshold,
        ThresholdType: "PERCENTAGE",
      },
    })
    .pipe(
      Effect.map((r) =>
        // `Subscriber.Address` is sensitive in distilled — unwrap the
        // Redacted for comparison.
        (r.Subscribers ?? []).map((s) =>
          Redacted.isRedacted(s.Address)
            ? Redacted.value(s.Address)
            : s.Address,
        ),
      ),
      Effect.catchTag("NotFoundException", () => Effect.succeed([])),
    );

const deployBudget = (options: {
  amount: string;
  subscriberAddress?: string;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const budget = yield* Budget("LifecycleBudget", {
      budgetName,
      budgetType: "COST",
      timeUnit: "MONTHLY",
      budgetLimit: { amount: options.amount, unit: "USD" },
      tags: options.tags,
      notifications: options.subscriberAddress
        ? [
            {
              notificationType: "ACTUAL",
              comparisonOperator: "GREATER_THAN",
              threshold: 80,
              thresholdType: "PERCENTAGE",
              subscribers: [
                {
                  subscriptionType: "EMAIL",
                  address: options.subscriberAddress,
                },
              ],
            },
          ]
        : undefined,
    });
    return { accountId: budget.accountId, budgetArn: budget.budgetArn };
  });

test.provider(
  "lifecycle: create with notification+tags, sync subscribers+tags, drop notification, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        deployBudget({
          amount: "100",
          subscriberAddress: "budget-test@example.com",
          tags: { Team: "alchemy-test" },
        }),
      );

      const accountId = deployed.accountId;
      expect(deployed.budgetArn).toBe(
        `arn:aws:budgets::${accountId}:budget/${budgetName}`,
      );

      // Out-of-band verification via distilled.
      const created = yield* getBudget(accountId);
      expect(created?.BudgetName).toBe(budgetName);
      expect(Number(created?.BudgetLimit?.Amount)).toBe(100);
      expect(created?.BudgetLimit?.Unit).toBe("USD");
      expect(created?.TimeUnit).toBe("MONTHLY");

      const notifications = yield* getNotifications(accountId).pipe(
        Effect.repeat({
          ...consistencyPolicy,
          until: (n): boolean => n.length > 0,
        }),
      );
      expect(notifications.length).toBe(1);
      expect(notifications[0]?.Threshold).toBe(80);

      // Tags — user tag plus the internal alchemy brand.
      const createdTags = yield* getTags(deployed.budgetArn);
      expect(createdTags.Team).toBe("alchemy-test");
      expect(
        Object.keys(createdTags).some((k) => k.startsWith("alchemy:")),
      ).toBe(true);

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Budget);
      const all = yield* provider.list();
      expect(all.some((b) => b.budgetName === budgetName)).toBe(true);

      // Update — raise the limit, change the notification's subscriber
      // (exercises subscriber sync on a kept notification), update the tag.
      yield* stack.deploy(
        deployBudget({
          amount: "250",
          subscriberAddress: "budget-test-updated@example.com",
          tags: { Team: "alchemy-test-updated" },
        }),
      );

      const updated = yield* getBudget(accountId);
      expect(Number(updated?.BudgetLimit?.Amount)).toBe(250);

      const subscribers = yield* getSubscribers(accountId, 80).pipe(
        Effect.repeat({
          ...consistencyPolicy,
          until: (s): boolean =>
            s.length === 1 && s[0] === "budget-test-updated@example.com",
        }),
      );
      expect(subscribers).toEqual(["budget-test-updated@example.com"]);

      const updatedTags = yield* getTags(deployed.budgetArn);
      expect(updatedTags.Team).toBe("alchemy-test-updated");

      // Update — drop the notification entirely.
      yield* stack.deploy(deployBudget({ amount: "250" }));

      const afterDrop = yield* getNotifications(accountId).pipe(
        Effect.repeat({
          ...consistencyPolicy,
          until: (n): boolean => n.length === 0,
        }),
      );
      expect(afterDrop.length).toBe(0);

      // Destroy — the budget is gone.
      yield* stack.destroy();
      const after = yield* getBudget(accountId);
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
